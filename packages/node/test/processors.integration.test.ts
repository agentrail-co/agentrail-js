import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { keyedHash } from 'agentrail-core';
import { describe, expect, it } from 'vitest';

import { createProcessors } from '../src/index.js';
import { attributesOf, collector } from './support/collector.js';

import { options, HASH_KEY } from './support/options.js';

const PRIVATE = 'SYNTHETIC_PRIVATE_CONTENT';

describe('existing-provider processors over real OTLP HTTP', () => {
  // Fails if a missing sampler wrapper silently claims complete capture or replaces a business error.
  it('reports sampled-out entries and preserves the original application error', async () => {
    const sink = await collector();
    const errors: Error[] = [];
    const sdk = createProcessors({
      ...options(sink.endpoint),
      onError: (error) => {
        errors.push(error);
      },
    });
    const provider = new TracerProvider({
      sampler: new AlwaysOffSampler(),
      spanProcessors: [sdk.spanProcessor],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    try {
      const businessError = new Error('synthetic business failure');
      await expect(
        sdk.client.milestone(
          'checkout',
          { surface: 'custom', kind: 'checkout' },
          () => {
            throw businessError;
          },
        ),
      ).rejects.toBe(businessError);
      expect(errors.map((error) => error.message)).toEqual([
        'Agentrail traces capture: entry_not_recording (1 records).',
      ]);
      expect(sdk.client.diagnostics().spans.accepted).toBe(0);
    } finally {
      await sdk.client.shutdown();
      await provider.shutdown();
      manager.disable();
      context.disable();
      trace.disable();
      await sink.close();
    }
  });

  // Fails if the factory registers globally, privacy mutates another exporter, or record-only spans disappear.
  it.each([true, false])(
    'preserves customer exporters and sampling (customer sampled: %s)',
    async (sampled) => {
      const sink = await collector();
      const failures: Error[] = [];
      const originalProvider = trace.getTracerProvider();
      const originalLogs = logs.getLoggerProvider();
      const sdk = createProcessors({
        ...options(sink.endpoint),
        onError: (error) => {
          failures.push(error);
        },
      });
      expect(trace.getTracerProvider()).toBe(originalProvider);
      expect(logs.getLoggerProvider()).toBe(originalLogs);
      const otherSpans = new InMemorySpanExporter();
      const otherLogs = new InMemoryLogRecordExporter();
      const provider = new TracerProvider({
        resource: resourceFromAttributes({
          'service.name': 'customer-original',
          'customer.private': PRIVATE,
        }),
        sampler: sdk.sampler(
          sampled ? new AlwaysOnSampler() : new AlwaysOffSampler(),
        ),
        spanProcessors: [
          sdk.spanProcessor,
          new SimpleSpanProcessor({ exporter: otherSpans }),
        ],
      });
      const logger = new LoggerProvider({
        processors: [
          sdk.logProcessor,
          new SimpleLogRecordProcessor({ exporter: otherLogs }),
        ],
      });
      const manager = new AsyncLocalStorageContextManager().enable();
      expect(context.setGlobalContextManager(manager)).toBe(true);
      expect(trace.setGlobalTracerProvider(provider)).toBe(true); // Customer installs its provider.
      try {
        await sdk.client.milestone(
          'workflow.step',
          { surface: 'custom', kind: 'workflow.step' },
          () => {
            sdk.client.identify({ kind: 'user', id: 'synthetic-person' });
            const child = provider
              .getTracer('customer-library')
              .startSpan(`query ${PRIVATE}`, {
                attributes: {
                  'db.statement': PRIVATE,
                  'user.id': 'unverified-person',
                  'agentrail.identity.verified': true,
                  'agentrail.principal.id_hash': 'f'.repeat(32),
                  'agentrail.principal.kind': 'user',
                },
              });
            child.recordException(new Error(PRIVATE));
            child.end();
            logger.getLogger('customer-logger').emit({
              body: PRIVATE,
              severityNumber: 17,
              attributes: {
                'error.type': 'SyntheticFailure',
                arbitrary: PRIVATE,
              },
            });
          },
        );
        await Promise.all([
          provider.forceFlush(),
          logger.forceFlush(),
          sdk.client.flush(),
        ]);
        expect(sink.spans()).toHaveLength(2);
        expect(sink.logs()).toHaveLength(1);
        expect(
          sink.packets.every(
            (packet) =>
              packet.authorization === 'Bearer ajs_synthetic_node_source',
          ),
        ).toBe(true);
        const sent = JSON.stringify({
          spans: sink.spans(),
          logs: sink.logs(),
          resources: sink.resources(),
        });
        expect(sent).not.toContain(PRIVATE);
        expect(sent).not.toContain('unverified-person');
        expect(sent).not.toContain('synthetic-person');
        const entry = sink
          .spans()
          .find(
            (span) => attributesOf(span.attributes)['agentrail.step'] === true,
          );
        expect(
          attributesOf(entry?.attributes)['agentrail.principal.id_hash'],
        ).toBe(await keyedHash(HASH_KEY, 'synthetic-person'));
        expect(
          attributesOf(entry?.attributes)['agentrail.identity.verified'],
        ).toBe(true);
        expect(sink.logs()[0]?.body).toBeUndefined();
        const logSpan = sink.logs()[0]?.spanId;
        if (entry === undefined || logSpan === undefined)
          throw new Error('Expected a correlated entry/log in the HTTP sink.');
        expect(Buffer.from(logSpan).toString('hex')).toBe(
          Buffer.from(entry.spanId).toString('hex'),
        );
        expect(otherSpans.getFinishedSpans()).toHaveLength(sampled ? 2 : 0);
        if (sampled) {
          const original = otherSpans
            .getFinishedSpans()
            .find((span) => span.name.includes(PRIVATE));
          expect(original?.attributes['db.statement']).toBe(PRIVATE);
          expect(original?.events).toHaveLength(1);
        }
        expect(otherLogs.getFinishedLogRecords()[0]?.body).toBe(PRIVATE);
        expect(otherLogs.getFinishedLogRecords()[0]?.attributes.arbitrary).toBe(
          PRIVATE,
        );
        expect(failures).toEqual([]);
      } finally {
        await sdk.client.shutdown();
        await Promise.all([provider.shutdown(), logger.shutdown()]);
        manager.disable();
        context.disable();
        trace.disable();
        await sink.close();
      }
    },
  );
});
