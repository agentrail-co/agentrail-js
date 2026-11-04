import { Writable } from 'node:stream';
import pinoLogger from 'pino';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { pino } from '../src/pino.js';
import { performance } from 'node:perf_hooks';
import { trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { describe, expect, it, vi } from 'vitest';
import {
  createProcessors,
  init,
  CaptureError,
  ConfigurationError,
} from '../src/index.js';
import { collector, attributesOf } from './support/collector.js';
import { options } from './support/options.js';

describe('delivery, privacy and provider ownership', () => {
  // Fails if a customer's reporting exception escapes a logging call or prevents later delivery.
  it.each(['client', 'pino'] as const)(
    'isolates throwing onError callbacks from %s logging and queue cleanup',
    async (bridge) => {
      const sink = await collector([401, 200]);
      const failures: CaptureError[] = [];
      const callbackFailure = new Error(
        'Synthetic reporting callback failure.',
      );
      const fallback = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      let throwReports = true;
      const sdk = createProcessors({
        ...options(sink.endpoint),
        queue: { maxRecords: 1, batchSize: 1 },
        onError: (error) => {
          failures.push(error);
          if (throwReports) throw callbackFailure;
        },
      });
      const output: string[] = [];
      const logger = pinoLogger(
        { hooks: pino(sdk.client) },
        new Writable({
          write(chunk, _encoding, done) {
            output.push(String(chunk));
            done();
          },
        }),
      );
      const emit = () => {
        if (bridge === 'client') sdk.client.log({});
        else logger.info('ordinary application log');
      };
      try {
        expect(() => {
          emit();
          emit();
        }).not.toThrow();
        await sdk.client.flush();
        expect(sdk.client.diagnostics().logs).toEqual({
          accepted: 1,
          exported: 0,
          dropped: 2,
          pending: 0,
        });
        emit();
        await sdk.client.flush();
        expect(sink.logs()).toHaveLength(2);
        expect(sdk.client.diagnostics().logs).toEqual({
          accepted: 2,
          exported: 1,
          dropped: 2,
          pending: 0,
        });
        expect(failures.map((error) => error.code)).toEqual([
          'queue_full',
          'export_failed',
        ]);
        expect(fallback.mock.calls).toEqual(
          failures.map((error) => [
            'Agentrail onError callback failed.',
            callbackFailure,
            error,
          ]),
        );
        if (bridge === 'pino') expect(output).toHaveLength(3);
      } finally {
        throwReports = false;
        await sdk.client.shutdown();
        await sink.close();
        fallback.mockRestore();
      }
    },
  );

  // Fails if an asynchronous reporting exception strands the in-flight batch after its callback.
  it('finishes an asynchronous export failure when onError throws', async () => {
    const sink = await collector([401, 200]);
    const fallback = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    let throwReports = true;
    const sdk = createProcessors({
      ...options(sink.endpoint),
      queue: {
        maxRecords: 1,
        batchSize: 1,
        exportTimeoutMs: 100,
        flushTimeoutMs: 200,
        shutdownTimeoutMs: 200,
      },
      onError: () => {
        if (throwReports) throw new Error('Synthetic async callback failure.');
      },
    });
    try {
      sdk.client.log({});
      await sdk.client.flush();
      expect(sdk.client.diagnostics().logs).toEqual({
        accepted: 1,
        exported: 0,
        dropped: 1,
        pending: 0,
      });
      sdk.client.log({});
      await sdk.client.flush();
      expect(sdk.client.diagnostics().logs).toEqual({
        accepted: 2,
        exported: 1,
        dropped: 1,
        pending: 0,
      });
    } finally {
      throwReports = false;
      await sdk.client.shutdown();
      await sink.close();
      fallback.mockRestore();
    }
  });

  // Fails if an already-finished empty drain suppresses the next record's export and timer.
  it('delivers a record added in the same turn as an empty flush without a second flush', async () => {
    const sink = await collector();
    const sdk = createProcessors({
      ...options(sink.endpoint),
      queue: { batchSize: 1 },
    });
    try {
      const empty = sdk.client.flush();
      sdk.client.log({});
      await empty;
      await vi.waitFor(
        () => {
          expect(sink.logs()).toHaveLength(1);
        },
        {
          timeout: 500,
        },
      );
      await vi.waitFor(
        () => {
          expect(sdk.client.diagnostics().logs).toEqual({
            accepted: 1,
            exported: 1,
            dropped: 0,
            pending: 0,
          });
        },
        { timeout: 500 },
      );
    } finally {
      await sdk.client.shutdown();
      await sink.close();
    }
  });

  // Fails if selected fields are sliced after JSON serialization or an oversized key drops later fitting fields.
  it.each([
    {
      name: 'long text',
      fields: { message: 'x'.repeat(4096) },
      selected: ['message'],
      keys: ['message'],
    },
    {
      name: 'escaped text',
      fields: { message: '"\\\n'.repeat(2000) },
      selected: ['message'],
      keys: ['message'],
    },
    {
      name: 'multiple fields and Unicode',
      fields: { code: 'synthetic', message: '😀'.repeat(3000), flag: true },
      selected: ['code', 'message', 'flag'],
      keys: ['code', 'message'],
    },
    {
      name: 'oversized field name',
      fields: {
        ['k'.repeat(4096)]: 'omit',
        count: 42,
        flag: false,
        empty: null,
      },
      selected: ['k'.repeat(4096), 'count', 'flag', 'empty'],
      keys: ['count', 'flag', 'empty'],
    },
  ])(
    'exports bounded parseable selected fields for $name',
    async ({ fields, selected, keys }) => {
      const sink = await collector();
      const sdk = createProcessors({
        ...options(sink.endpoint),
        logs: { includeFields: selected },
      });
      try {
        sdk.client.log({
          fields: { ...fields, private: 'SYNTHETIC_UNSELECTED' },
        });
        await sdk.client.flush();
        const body = sink.logs()[0]?.body?.stringValue;
        expect(body).toBeTypeOf('string');
        if (body === undefined)
          throw new Error('Expected selected log fields.');
        expect(body.length).toBeLessThanOrEqual(4096);
        expect(body.isWellFormed()).toBe(true);
        const parsed = JSON.parse(body) as Record<string, unknown>;
        expect(Object.keys(parsed)).toEqual(keys);
        if (typeof fields.message === 'string') {
          expect(parsed.message).toBeTypeOf('string');
          expect(String(parsed.message).length).toBeGreaterThan(0);
          expect(fields.message.startsWith(String(parsed.message))).toBe(true);
          expect(String(parsed.message).isWellFormed()).toBe(true);
        } else expect(parsed).toEqual({ count: 42, flag: false, empty: null });
        expect(body).not.toContain('SYNTHETIC_UNSELECTED');
      } finally {
        await sdk.client.shutdown();
        await sink.close();
      }
    },
  );

  // Fails if SDK diagnostics feed back through a supported logger into their own full queue.
  it.each(['pino', 'otel'] as const)(
    'does not recapture its own %s failure reports during overflow/outage',
    async (bridge) => {
      const sink = await collector([0]);
      const errors: CaptureError[] = [];
      let reporting = true;
      const diagnostic = (error: Error) => {
        if (bridge === 'pino') logger.error(error);
        else
          logs
            .getLogger('diagnostics')
            .emit({ severityNumber: 17, body: error.message });
      };
      const sdk = createProcessors({
        ...options(sink.endpoint),
        queue: {
          maxRecords: 1,
          batchSize: 1,
          exportTimeoutMs: 100,
          flushTimeoutMs: 200,
          shutdownTimeoutMs: 200,
        },
        onError: (error) => {
          errors.push(error);
          if (reporting) diagnostic(error);
        },
      });
      const output: string[] = [];
      const logger = pinoLogger(
        { hooks: pino(sdk.client) },
        new Writable({
          write(chunk, _encoding, done) {
            output.push(String(chunk));
            done();
          },
        }),
      );
      const logs = new LoggerProvider({ processors: [sdk.logProcessor] });
      const emit = () => {
        if (bridge === 'pino') logger.info('ordinary application log');
        else logs.getLogger('application').emit({ severityNumber: 9 });
      };
      try {
        expect(() => {
          emit();
          emit();
        }).not.toThrow();
        await sdk.client.flush();
        expect(errors.map((error) => error.code)).toEqual([
          'queue_full',
          'export_failed',
        ]);
        expect(sdk.client.diagnostics().logs).toEqual({
          accepted: 1,
          exported: 0,
          dropped: 2,
          pending: 0,
        });
        if (bridge === 'pino') expect(output).toHaveLength(4);
      } finally {
        reporting = false;
        await sdk.client.shutdown();
        await logs.shutdown();
        await sink.close();
      }
    },
  );

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
        severityText: 'ER\u0000ROR',
        eventName: 'checkout.\u0000failed',
        fields: {
          msg: 'selected synthetic message',
          password: 'SYNTHETIC_PRIVATE',
        },
      });
      await sdk.client.flush();
      expect(sink.packets).toHaveLength(2);
      expect(sink.packets[0]?.bytes).toEqual(sink.packets[1]?.bytes);
      expect(sink.logs()[0]?.severityText).toBe('ERROR');
      expect(sink.logs()[0]?.eventName).toBe('checkout.failed');
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
