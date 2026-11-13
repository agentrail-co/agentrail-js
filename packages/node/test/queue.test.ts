import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { describe, expect, it } from 'vitest';

import { ExportQueue } from '../src/queue.js';
import { resolveOptions } from '../src/options.js';
import { EXPORT_BATCH_BYTES } from '../src/limits.js';
import { options } from './support/options.js';

describe('queue drain completion', () => {
  // Fails if records arriving between the last batch and finally are left without delivery.
  it('includes a record queued between the final batch and drain cleanup', async () => {
    const batches: number[][] = [];
    let finish: ((result: ExportResult) => void) | undefined;
    const queue = new ExportQueue<number>(
      'logs',
      {
        export(records, done) {
          batches.push([...records]);
          if (batches.length === 1) finish = done;
          else done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      },
      resolveOptions({
        ...options('http://127.0.0.1:1'),
        queue: { batchSize: 1 },
      }),
    );
    try {
      queue.add(1);
      const draining = queue.flush();
      if (finish === undefined) throw new Error('Expected the first batch.');
      finish({ code: ExportResultCode.SUCCESS });
      queueMicrotask(() => {
        queue.add(2);
      });
      await draining;
      expect(batches).toEqual([[1], [2]]);
      expect(queue.diagnostics()).toEqual({
        accepted: 2,
        exported: 2,
        dropped: 0,
        pending: 0,
      });
    } finally {
      await queue.shutdown();
    }
  });
});

const MiB = 1024 * 1024;

describe('byte-sized batches', () => {
  // Fails if someone batches by record count alone: records that fit the
  // count but not one export would make the whole batch fail.
  it('closes a batch before its estimated size passes what one export carries', async () => {
    const batches: number[][] = [];
    const queue = new ExportQueue<number>(
      'traces',
      {
        export(records, done) {
          batches.push([...records]);
          done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      },
      resolveOptions(options('http://127.0.0.1:1')),
      {
        bytes: () => 6 * MiB,
        payloadBytes: () => 0,
        withoutPayloads: (record) => record,
      },
    );
    try {
      for (const record of [1, 2, 3, 4, 5]) queue.add(record);
      await queue.flush();
      expect(batches).toEqual([[1, 2], [3, 4], [5]]);
      expect(
        batches.every((batch) => batch.length * 6 * MiB <= EXPORT_BATCH_BYTES),
      ).toBe(true);
    } finally {
      await queue.shutdown();
    }
  });

  // Fails if someone stops counting in-flight payloads against the budget,
  // never gives the budget back, or drops the span with its payload.
  it('drops payloads past the queue budget, in flight included, keeps the span, and reports it', async () => {
    interface Item {
      readonly id: number;
      readonly payload: boolean;
    }
    const batches: Item[][] = [];
    const codes: string[] = [];
    let finish: ((result: ExportResult) => void) | undefined;
    const queue = new ExportQueue<Item>(
      'traces',
      {
        export(records, done) {
          batches.push([...records]);
          if (finish === undefined) finish = done;
          else done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      },
      resolveOptions({
        ...options('http://127.0.0.1:1'),
        queue: { batchSize: 1 },
        onError: (error) => {
          codes.push(error.code);
        },
      }),
      {
        bytes: () => 1,
        payloadBytes: (item) => (item.payload ? 40 * MiB : 0),
        withoutPayloads: (item) => ({ ...item, payload: false }),
      },
    );
    try {
      queue.add({ id: 1, payload: true });
      // The first is in flight, holding 40 MiB of the 64.
      queue.add({ id: 2, payload: true });
      expect(codes).toEqual(['payload_budget']);
      if (finish === undefined) throw new Error('Expected the first batch.');
      finish({ code: ExportResultCode.SUCCESS });
      await queue.flush();
      queue.add({ id: 3, payload: true });
      await queue.flush();
      expect(batches).toEqual([
        [{ id: 1, payload: true }],
        [{ id: 2, payload: false }],
        [{ id: 3, payload: true }],
      ]);
      expect(codes).toEqual(['payload_budget']);
      expect(queue.diagnostics()).toMatchObject({ exported: 3, dropped: 0 });
    } finally {
      await queue.shutdown();
    }
  });
});
