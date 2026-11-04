import { ExportResultCode, suppressTracing } from '@opentelemetry/core';
import { context } from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { CaptureError, type ResolvedOptions } from './options.js';

interface Exporter<T> {
  export(records: T[], callback: (result: ExportResult) => void): void;
  shutdown(): Promise<void>;
}
export interface QueueStats {
  accepted: number;
  exported: number;
  dropped: number;
  pending: number;
}
/** One in-flight batch; its records still consume capacity. The vendor transport owns OTLP retry policy. */
export class ExportQueue<T> {
  private records: T[] = [];
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
  ) {}
  diagnostics(): QueueStats {
    return { ...this.stats, pending: this.records.length + this.inFlight };
  }
  add(record: T): void {
    if (
      this.closed ||
      this.records.length + this.inFlight >= this.options.queue.maxRecords
    ) {
      this.drop(this.closed ? 'closed' : 'queue_full', 1);
      return;
    }
    this.records.push(record);
    this.stats.accepted++;
    if (this.records.length >= this.options.queue.batchSize) void this.drain();
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
        if (result.code === ExportResultCode.SUCCESS)
          this.stats.exported += batch.length;
        else this.drop('export_failed', batch.length, result.error);
        resolve();
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
  private drain(): Promise<void> {
    if (this.active !== undefined) return this.active;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.active = (async () => {
      while (this.records.length > 0) {
        const batch = this.records.splice(0, this.options.queue.batchSize);
        this.inFlight = batch.length;
        await this.exportBatch(batch);
        this.inFlight = 0;
      }
    })().finally(() => {
      this.active = undefined;
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
          this.records = [];
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
