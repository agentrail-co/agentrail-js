import { createRequire, syncBuiltinESMExports } from 'node:module';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, it } from 'vitest';
import { init } from '../src/index.js';
import {
  CLI_VALUE,
  OK,
  application,
  arrive,
  calls,
  downstream,
  shape,
  traceOf,
} from './support/beside.js';
import { collector } from './support/collector.js';
import { options } from './support/options.js';

// Fails if someone keeps the SDK's request state in OpenTelemetry's
// context: the customer's instrumentation starts each request in a context
// of its own, and the SDK's spans would land in the customer's trace (or its
// state be lost). Also fails if the customer's span inside a request stops
// being its own server span's child, if the customer's undici
// instrumentation, subscribed after the SDK, adds a second traceparent to a
// call to an allowed origin, or if a milestone outside a request stops
// linking to the customer's span it ran in.
it('runs beside an OpenTelemetry setup registered after it', async () => {
  const sink = await collector();
  const ordinary = await downstream();
  const allowed = await downstream();
  const sdk = await init({
    ...options(sink.endpoint),
    outboundOrigins: [allowed.origin],
    ignoreIncomingRequest: (request) =>
      [ordinary.port, allowed.port].includes(request.socket.localPort ?? 0),
  });
  const app = await application(sdk, ordinary.origin, allowed.origin, () =>
    trace.getTracer('customer').startActiveSpan('customer.query', (span) => {
      span.end();
      return Promise.resolve();
    }),
  );
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const incoming = {
    traceparent: `00-${traceId}-b7ad6b7169203331-01`,
    tracestate: 'upstream=synthetic',
    'x-agentrail-cli': CLI_VALUE,
  };
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter })],
  });
  const manager = new AsyncLocalStorageContextManager();
  let instrumentations: { disable(): void }[] = [];
  try {
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();
    const alone = shape(sink.spans());
    const before = sink.spans().length;
    ordinary.seen.clear();
    allowed.seen.clear();
    // The customer's own setup, after Agentrail's.
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    expect(context.setGlobalContextManager(manager.enable())).toBe(true);
    expect(
      propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    ).toBe(true);
    instrumentations = [new HttpInstrumentation(), new UndiciInstrumentation()];
    const require = createRequire(import.meta.url);
    require('node:http');
    require('node:https');
    syncBuiltinESMExports();
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();

    const made = calls(ordinary.seen, allowed.seen);
    const all = Object.values(made);
    expect(all.every((call) => call !== undefined)).toBe(true);
    // (1) The customer's trace went on through the SDK's capture.
    const theirs = exporter.getFinishedSpans();
    const server = theirs.find(
      (span) =>
        span.kind === SpanKind.SERVER &&
        span.attributes['url.path'] === '/checkout',
    );
    expect(server?.spanContext().traceId).toBe(traceId);
    const underServer = theirs.filter(
      (span) => span.parentSpanContext?.spanId === server?.spanContext().spanId,
    );
    expect(
      underServer.map((span) => `${String(span.kind)} ${span.name}`).sort(),
    ).toEqual(
      [
        `${String(SpanKind.CLIENT)} GET`,
        `${String(SpanKind.CLIENT)} GET`,
        `${String(SpanKind.CLIENT)} GET`,
        `${String(SpanKind.CLIENT)} GET`,
        `${String(SpanKind.INTERNAL)} customer.query`,
      ].sort(),
    );
    for (const call of [made.ordinaryFetch, made.ordinaryRequest]) {
      expect(traceOf(call)).toBe(traceId);
      expect(call?.headers.tracestate).toContain('upstream=synthetic');
      // (2) The SDK's own headers stay off an ordinary origin.
      expect(call?.handoff).toBe('missing');
      expect(call?.headers['x-agentrail-cli']).toBeUndefined();
    }
    const entry = sink
      .spans()
      .slice(before)
      .find((span) => span.kind === 2);
    for (const call of [made.allowedFetch, made.allowedRequest]) {
      expect(call?.handoff).toBe('verified');
      expect(traceOf(call)).toBe(
        entry === undefined
          ? 'none'
          : Buffer.from(entry.traceId).toString('hex'),
      );
      expect(call?.headers.tracestate).toBeUndefined();
      expect(call?.headers['x-agentrail-cli']).toBeUndefined();
    }
    // (3) The collector got what it got without the customer's setup.
    expect(shape(sink.spans().slice(before))).toEqual(alone);

    // Outside a request, a milestone inside the customer's span links to
    // it, and the customer's span stays the current one.
    const job = trace
      .getTracer('customer')
      .startActiveSpan('customer.job', (span) => {
        sdk.milestone('job.done', { surface: 'custom', kind: 'job.done' });
        expect(trace.getActiveSpan()).toBe(span);
        span.end();
        return span.spanContext();
      });
    await sdk.flush();
    const done = sink.spans().find((span) => span.name === 'job.done');
    expect(
      done?.links?.map((link) => [
        Buffer.from(link.traceId).toString('hex'),
        Buffer.from(link.spanId).toString('hex'),
      ]),
    ).toEqual([[job.traceId, job.spanId]]);
  } finally {
    for (const instrumentation of instrumentations) instrumentation.disable();
    await sdk.shutdown();
    await provider.shutdown();
    manager.disable();
    context.disable();
    propagation.disable();
    trace.disable();
    await app.close();
    await ordinary.close();
    await allowed.close();
    await sink.close();
  }
});
