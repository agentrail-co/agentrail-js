import { createHmac, createHash } from 'node:crypto';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { OTLP } from 'agentrail-contract';
import { expect, it } from 'vitest';
import { createProcessors, type PerformanceContext } from '../src/index.js';
import { attributesOf, collector } from './support/collector.js';
import { options, HASH_KEY } from './support/options.js';
const namespaceId = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const privateRef = 'synthetic-private-operation-attempt';

// Fails if operation IDs leave the process unhashed, lose namespace isolation,
// inherit from unrelated spans, or silently turn an invocation into an outcome.
it('exports explicit authorized operation evidence over OTLP without raw references or arguments', async () => {
  const sink = await collector();
  const sdk = createProcessors(options(sink.endpoint));
  const provider = new TracerProvider({ spanProcessors: [sdk.spanProcessor] });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  const performance: PerformanceContext = {
    environment: 'production',
    operation: { namespaceId, instanceRef: privateRef, role: 'start' },
    eventName: 'delivery.requested',
    plugin: { bindingId, invocationId: 'invocation-1' },
  };
  try {
    await sdk.client.milestone(
      'delivery.requested',
      { surface: 'custom', kind: 'business.event', performance },
      () => {
        const child = provider.getTracer('customer').startSpan('untrusted');
        child.setAttribute('agentrail.operation.hash', privateRef);
        child.setAttribute('tool.arguments', privateRef);
        child.end();
      },
    );
    sdk.client.milestone('delivery.completed', {
      surface: 'custom',
      kind: 'business.event',
      performance: {
        ...performance,
        operation: { ...performance.operation, role: 'terminal' },
        eventName: 'delivery.completed',
      },
    });
    sdk.client.milestone('next.attempt', {
      surface: 'custom',
      kind: 'business.event',
      performance: {
        ...performance,
        operation: {
          ...performance.operation,
          instanceRef: `${privateRef}-next`,
        },
      },
    });
    sdk.client.milestone('other.namespace', {
      surface: 'custom',
      kind: 'business.event',
      performance: {
        ...performance,
        operation: { ...performance.operation, namespaceId: bindingId },
      },
    });
    sdk.client.milestone('plugin.invoked', {
      surface: 'mcp',
      kind: 'mcp.tool',
      performance: {
        environment: 'test',
        plugin: { bindingId, invocationId: 'unassigned' },
      },
    });
    await sdk.client.flush();
    const spans = sink.spans();
    const first = attributesOf(
      spans.find((span) => span.name === 'delivery.requested')?.attributes,
    );
    const hash = createHmac('sha256', HASH_KEY)
      .update(JSON.stringify(['agentrail.operation', namespaceId, privateRef]))
      .digest('hex');
    for (const key of Object.keys(first).filter((key) =>
      key.startsWith('agentrail.'),
    ))
      expect(Object.values(OTLP.spanAttributes)).toContain(key);
    expect(first).toMatchObject({
      'agentrail.operation.namespace_id': namespaceId,
      'agentrail.operation.hash': hash,
      'agentrail.environment': 'production',
      'agentrail.workflow.role': 'start',
      'agentrail.workflow.event_name': 'delivery.requested',
      'agentrail.plugin.binding_id': bindingId,
      'agentrail.plugin.invocation_id': 'invocation-1',
    });
    expect(
      attributesOf(
        spans.find((span) => span.name === 'delivery.completed')?.attributes,
      ),
    ).toMatchObject({
      'agentrail.operation.hash': hash,
      'agentrail.workflow.role': 'terminal',
    });
    for (const name of ['next.attempt', 'other.namespace'])
      expect(
        attributesOf(spans.find((span) => span.name === name)?.attributes)[
          'agentrail.operation.hash'
        ],
      ).not.toBe(hash);
    const standalone = attributesOf(
      spans.find((span) => span.name === 'plugin.invoked')?.attributes,
    );
    expect(standalone).toMatchObject({
      'agentrail.environment': 'test',
      'agentrail.plugin.invocation_id': 'unassigned',
    });
    expect(standalone).not.toHaveProperty(['agentrail.operation.hash']);
    expect(standalone).not.toHaveProperty(['agentrail.workflow.role']);
    expect(
      attributesOf(
        spans.find((span) => span.name === 'backend.operation')?.attributes,
      ),
    ).not.toHaveProperty(['agentrail.operation.hash']);
    expect(JSON.stringify(spans)).not.toContain(privateRef);
    expect(sink.resources()).toContainEqual(
      expect.objectContaining({
        'agentrail.hash_key_id': createHash('sha256')
          .update(HASH_KEY)
          .digest('hex')
          .slice(0, 16),
      }),
    );
  } finally {
    await sdk.client.shutdown();
    await provider.shutdown();
    manager.disable();
    context.disable();
    trace.disable();
    await sink.close();
  }
});
