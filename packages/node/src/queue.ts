import { ExportResultCode, suppressTracing } from '@opentelemetry/core';
import { context } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { CaptureError, type ResolvedOptions } from './options.js';
import { EXPORT_BATCH_BYTES, QUEUE_PAYLOAD_BYTES } from './limits.js';

interface Exporter<T> {
  export(records: T[], callback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
}
/** How a queue weighs its records; a queue without one counts records only. */
export interface Sizing<T> {
  /** An upper estimate of the record's encoded size. */
  bytes(record: T): number;
  /** The payload text it holds, against the queue's payload budget. */
  payloadBytes(record: T): number;
  withoutPayloads(record: T): T;
}
interface Entry<T> {
  readonly record: T;
  readonly bytes: number;
  readonly payload: number;
}
export interface QueueStats {
  accepted: number;
  exported: number;
  dropped: number;
  pending: number;
}
/**
 * One in-flight batch; its records still consume capacity. A batch closes at
 * `batchSize` records or before its estimated size passes what one export
 * carries. The vendor transport owns OTLP retry policy.
 */
export class ExportQueue<T> {
  private records: Entry<T>[] = [];
  private queuedBytes = 0;
  /** Payload text queued or in flight. */
  private payloadHeld = 0;
  private active: Promise<void> | undefined;
  private inFlight = 0;
  private cancelActive: (() => void) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private stop: Promise<void> | undefined;
  private readonly stats = { accepted: 0, exported: 0, dropped: 0 };
  constructor(
    private readonly signal: 'traces' | 'logs',
    private readonly exporter: Exporter<T>,
    private readonly options: ResolvedOptions,
    private readonly sizing?: Sizing<T>,
  ) {}
  diagnostics(): QueueStats {
    return { ...this.stats, pending: this.records.length + this.inFlight };
  }
  add(given: T): void {
    if (
      this.closed ||
      this.records.length + this.inFlight >= this.options.queue.maxRecords
    ) {
      this.drop(this.closed ? 'closed' : 'queue_full', 1);
      return;
    }
    let record = given;
    let payload = 0;
    let bytes = 0;
    const sizing = this.sizing;
    if (sizing !== undefined) {
      payload = sizing.payloadBytes(record);
      if (payload > 0 && this.payloadHeld + payload > QUEUE_PAYLOAD_BYTES) {
        // The span still goes; only its payloads are dropped.
        record = sizing.withoutPayloads(record);
        payload = 0;
        this.options.report(new CaptureError('payload_budget', this.signal, 1));
      }
      bytes = sizing.bytes(record);
    }
    this.records.push({ record, bytes, payload });
    this.queuedBytes += bytes;
    this.payloadHeld += payload;
    this.stats.accepted++;
    if (
      this.records.length >= this.options.queue.batchSize ||
      this.queuedBytes >= EXPORT_BATCH_BYTES
    )
      void this.drain();
    else if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, this.options.queue.scheduledDelayMs);
      this.timer.unref();
    }
  }
  private drop(
    code: 'closed' | 'queue_full' | 'export_failed' | 'deadline',
    count: number,
    cause?: Error,
  ): void {
    this.stats.dropped += count;
    this.options.report(new CaptureError(code, this.signal, count, cause));
  }
  private exportBatch(batch: T[]): Promise<void> {
    return new Promise((resolve) => {
      let finished = false;
      const done = (result: ExportResult) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.cancelActive = undefined;
        try {
          if (result.code === ExportResultCode.SUCCESS)
            this.stats.exported += batch.length;
          else this.drop('export_failed', batch.length, result.error);
        } finally {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        done({
          code: ExportResultCode.FAILED,
          error: new Error('OTLP export deadline exceeded.'),
        });
      }, this.options.queue.exportTimeoutMs);
      this.cancelActive = () => {
        done({
          code: ExportResultCode.FAILED,
          error: new Error('OTLP flush or shutdown deadline exceeded.'),
        });
      };
      context.with(suppressTracing(context.active()), () => {
        this.exporter.export(batch, done);
      });
    });
  }
  /** At least one record, so one estimated over the limit still goes, alone. */
  private nextBatchLength(): number {
    let count = 0;
    let bytes = 0;
    for (const entry of this.records) {
      if (
        count === this.options.queue.batchSize ||
        (count > 0 && bytes + entry.bytes > EXPORT_BATCH_BYTES)
      )
        break;
      bytes += entry.bytes;
      count++;
    }
    return count;
  }
  private drain(): Promise<void> {
    if (this.active !== undefined) return this.active;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = (async () => {
      while (this.records.length > 0) {
        const batch = this.records.splice(0, this.nextBatchLength());
        this.inFlight = batch.length;
        for (const entry of batch) this.queuedBytes -= entry.bytes;
        await this.exportBatch(batch.map((entry) => entry.record));
        this.inFlight = 0;
        for (const entry of batch) this.payloadHeld -= entry.payload;
      }
    })().finally(() => {
      this.active = undefined;
      // A record can arrive after the loop ended but before this microtask.
      // Chain its drain so flush/shutdown also wait for that delivery.
      if (this.records.length > 0) return this.drain();
    });
    return this.active;
  }
  private async bounded(work: Promise<void>, timeout: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          const count = this.records.length;
          for (const entry of this.records) this.payloadHeld -= entry.payload;
          this.records = [];
          this.queuedBytes = 0;
          if (count > 0) this.drop('deadline', count);
          this.cancelActive?.();
          resolve();
        }, timeout);
      }),
    ]);
    clearTimeout(timer);
  }
  async flush(): Promise<void> {
    await this.bounded(this.drain(), this.options.queue.flushTimeoutMs);
  }
  shutdown(): Promise<void> {
    this.stop ??= (async () => {
      this.closed = true;
      clearTimeout(this.timer);
      await this.bounded(
        this.drain().then(() => this.exporter.shutdown()),
        this.options.queue.shutdownTimeoutMs,
      );
    })();
    return this.stop;
  }
}
