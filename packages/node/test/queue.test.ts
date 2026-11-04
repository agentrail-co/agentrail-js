import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { describe, expect, it } from 'vitest';

import { ExportQueue } from '../src/queue.js';
import { resolveOptions } from '../src/options.js';
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
