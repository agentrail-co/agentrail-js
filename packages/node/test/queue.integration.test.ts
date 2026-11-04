import { performance } from 'node:perf_hooks';
import { trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { describe, expect, it } from 'vitest';
import {
  createProcessors,
  init,
  CaptureError,
  ConfigurationError,
} from '../src/index.js';
import { collector, attributesOf } from './support/collector.js';
import { options } from './support/options.js';

describe('delivery, privacy and provider ownership', () => {
  // Fails if retryable OTLP failures become permanent, or a retry creates a second logical log ID.
  it('retries transient refusal with the same sanitized record', async () => {
    const sink = await collector([503, 200]);
    const errors: CaptureError[] = [];
    const sdk = createProcessors({
      ...options(sink.endpoint),
      logs: { includeFields: ['msg'] },
      queue: {
        exportTimeoutMs: 3000,
        flushTimeoutMs: 4000,
        shutdownTimeoutMs: 4000,
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      sdk.client.log({
        severityNumber: 17,
        errorType: 'SyntheticError',
        fields: {
          msg: 'selected synthetic message',
          password: 'SYNTHETIC_PRIVATE',
        },
      });
      await sdk.client.flush();
      expect(sink.packets).toHaveLength(2);
      expect(sink.packets[0]?.bytes).toEqual(sink.packets[1]?.bytes);
      expect(sink.logs()[0]?.body?.stringValue).toBe(
        '{"msg":"selected synthetic message"}',
      );
      expect(sink.packets[0]?.bytes.toString()).not.toContain(
        'SYNTHETIC_PRIVATE',
      );
      expect(attributesOf(sink.logs()[0]?.attributes)['error.type']).toBe(
        'SyntheticError',
      );
      expect(sdk.client.diagnostics().logs).toEqual({
        accepted: 1,
        exported: 1,
        dropped: 0,
        pending: 0,
      });
      expect(errors).toEqual([]);
    } finally {
      await sdk.client.shutdown();
      await sink.close();
    }
  });
  // Fails if the queue excludes in-flight records from capacity, 401s retry, or failure silently counts as delivery.
  it('bounds the queue and reports overflow and permanent refusal', async () => {
    const sink = await collector([401, 200]);
    const errors: CaptureError[] = [];
    const sdk = createProcessors({
      ...options(sink.endpoint),
      queue: { maxRecords: 2, batchSize: 1 },
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      sdk.client.log({});
      sdk.client.log({});
      sdk.client.log({});
      await sdk.client.flush();
      expect(sink.packets).toHaveLength(2);
      expect(sdk.client.diagnostics().logs).toEqual({
        accepted: 2,
        exported: 1,
        dropped: 2,
        pending: 0,
      });
      expect(errors.map((error) => error.code).sort()).toEqual([
        'export_failed',
        'queue_full',
      ]);
      await sdk.client.shutdown();
      sdk.client.log({});
      expect(errors.at(-1)?.code).toBe('closed');
    } finally {
      await sdk.client.shutdown();
      await sink.close();
    }
  });
  // Fails if a stalled collector can hold process shutdown indefinitely or discarded records remain unreported.
  it('returns within the shutdown deadline during an outage', async () => {
    const sink = await collector([0, 0]);
    const errors: CaptureError[] = [];
    const sdk = createProcessors({
      ...options(sink.endpoint),
      queue: {
        maxRecords: 3,
        batchSize: 1,
        exportTimeoutMs: 200,
        flushTimeoutMs: 300,
        shutdownTimeoutMs: 300,
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    try {
      sdk.client.log({});
      sdk.client.log({});
      sdk.client.log({});
      const start = performance.now();
      await sdk.client.shutdown();
      expect(performance.now() - start).toBeLessThan(650);
      expect(sdk.client.diagnostics().logs.dropped).toBe(3);
      expect(errors.reduce((sum, error) => sum + error.count, 0)).toBe(3);
    } finally {
      await sdk.client.shutdown();
      await sink.close();
    }
  });
  // Fails if init silently overwrites an existing provider instead of requiring construction-time processor wiring.
  it('refuses an already-installed provider without replacing it', async () => {
    const provider = new TracerProvider();
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const sink = await collector();
    try {
      const before = trace.getTracerProvider();
      expect(() => init(options(sink.endpoint))).toThrow(ConfigurationError);
      expect(trace.getTracerProvider()).toBe(before);
    } finally {
      trace.disable();
      await provider.shutdown();
      await sink.close();
    }
  });
});
