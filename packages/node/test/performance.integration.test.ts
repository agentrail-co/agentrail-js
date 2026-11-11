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
const privateRef = 'synthetic-private-operation-attempt\u0000';

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

// This test fails if invalid per-call evidence is exported or prevents the customer's operation.
it('reports invalid evidence while preserving customer execution and unrelated OTLP spans', async () => {
  const sink = await collector();
  const errors: import('../src/options.js').CaptureError[] = [];
  const sdk = createProcessors({
    ...options(sink.endpoint),
    onError: (error) => errors.push(error),
  });
  const provider = new TracerProvider({ spanProcessors: [sdk.spanProcessor] });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
  const invalid: PerformanceContext[] = [
    {
      environment: 'production',
      plugin: {
        bindingId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        invocationId: 'opaque',
      },
    },
    {
      environment: 'production',
      plugin: {
        bindingId: '00000000-0000-0000-0000-000000000000',
        invocationId: 'opaque',
      },
    },
    {
      environment: 'production',
      plugin: {
        bindingId: '22222222-2222-9222-8222-222222222222',
        invocationId: 'opaque',
      },
    },
    {
      environment: 'production',
      operation: {
        namespaceId: '11111111-1111-4111-7111-111111111111',
        instanceRef: 'authorized',
        role: 'start',
      },
      eventName: 'delivery.requested',
    },
    {
      environment: 'production',
      plugin: { bindingId, invocationId: 'x'.repeat(257) },
    },
    {
      environment: 'production',
      operation: { namespaceId, instanceRef: 'authorized', role: 'start' },
      eventName: 'invalid event',
    },
  ];
  try {
    for (const [i, performance] of invalid.entries()) {
      expect(
        await sdk.client.milestone(
          `invalid.${i}`,
          { surface: 'custom', kind: 'business.event', performance },
          () => `customer-result-${i}`,
        ),
      ).toBe(`customer-result-${i}`);
    }
    sdk.client.milestone('unrelated', {
      surface: 'custom',
      kind: 'business.event',
    });
    await sdk.client.flush();
    expect(errors.map((error) => error.code)).toEqual(
      invalid.map(() => 'invalid_performance'),
    );
    const spans = sink.spans();
    expect(spans.map((span) => span.name)).toContain('unrelated');
    for (const [i] of invalid.entries()) {
      const span = spans.find((item) => item.name === `invalid.${i}`);
      expect(span).toBeDefined();
      const attributes = attributesOf(span?.attributes);
      for (const prefix of [
        'agentrail.operation.',
        'agentrail.workflow.',
        'agentrail.plugin.',
      ])
        expect(
          Object.keys(attributes).filter((key) => key.startsWith(prefix)),
        ).toEqual([]);
    }
  } finally {
    await sdk.client.shutdown();
    await provider.shutdown();
    manager.disable();
    context.disable();
    trace.disable();
    await sink.close();
  }
});
