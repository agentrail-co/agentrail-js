import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { context, propagation, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import * as Sentry from '@sentry/node';
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
} from '@sentry/opentelemetry';
import { expect, it } from 'vitest';
import { createProcessors } from '../src/index.js';
import { collector } from './support/collector.js';
import { options } from './support/options.js';

// Fails if a retained customer propagator leaks managed baggage after Undici's requestHook, or loses unrelated propagation.
it('composes Sentry propagation at final injection and preserves unmanaged work', async () => {
  const sink = await collector();
  const headers = new Map<string, import('node:http').IncomingHttpHeaders>();
  const server = createServer((request, response) => {
    headers.set(request.url ?? '', request.headers);
    response.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture address.');
  const origin = `http://127.0.0.1:${address.port}`;
  const client = Sentry.init({
    dsn: 'https://public@synthetic.invalid/1',
    defaultIntegrations: false,
    skipOpenTelemetrySetup: true,
    tracesSampleRate: 1,
    propagateTraceparent: true,
    tracePropagationTargets: [/.*/u],
    transport: () => ({
      send: () => Promise.resolve({ statusCode: 200 }),
      flush: () => Promise.resolve(true),
    }),
  });
  if (client === undefined) throw new Error('No synthetic Sentry client.');
  const configuration = {
    ...options(sink.endpoint),
    outboundOrigins: [],
    propagator: new SentryPropagator(),
  };
  const sdk = createProcessors(configuration);
  const provider = new TracerProvider({
    sampler: sdk.sampler(new SentrySampler(client)),
    spanProcessors: [sdk.spanProcessor, new SentrySpanProcessor({ client })],
  });
  const manager = new Sentry.SentryContextManager().enable();
  expect(trace.setGlobalTracerProvider(provider)).toBe(true);
  expect(context.setGlobalContextManager(manager)).toBe(true);
  expect(propagation.setGlobalPropagator(sdk.propagator)).toBe(true);
  const http = new HttpInstrumentation({
    ...sdk.httpOptions,
    disableIncomingRequestInstrumentation: true,
  });
  const undici = new UndiciInstrumentation(sdk.undiciOptions);
  http.setTracerProvider(provider);
  undici.setTracerProvider(provider);
  const require = createRequire(import.meta.url);
  require('node:http');
  require('node:https');
  syncBuiltinESMExports();
  const withBaggage = <T>(run: () => T) =>
    context.with(
      propagation.setBaggage(
        context.active(),
        propagation.createBaggage({
          'private-review-key': { value: 'synthetic-private-value' },
        }),
      ),
      run,
    );
  try {
    await sdk.client.milestone(
      'managed',
      { surface: 'custom', kind: 'managed' },
      () =>
        withBaggage(async () => {
          const response = await fetch(`${origin}/managed`);
          await response.text();
        }),
    );
    await provider
      .getTracer('customer')
      .startActiveSpan('customer', async (span) => {
        try {
          await withBaggage(async () => {
            const response = await fetch(`${origin}/customer`);
            await response.text();
          });
        } finally {
          span.end();
        }
      });
    expect(headers.get('/managed')?.traceparent).toBeUndefined();
    expect(headers.get('/managed')?.['sentry-trace']).toBeUndefined();
    expect(headers.get('/managed')?.baggage).toBeUndefined();
    expect(headers.get('/customer')?.traceparent).toBeDefined();
    expect(headers.get('/customer')?.['sentry-trace']).toBeDefined();
    expect(headers.get('/customer')?.baggage).toContain(
      'private-review-key=synthetic-private-value',
    );
    await sdk.client.flush();
  } finally {
    http.disable();
    undici.disable();
    await sdk.client.shutdown();
    await provider.shutdown();
    await Sentry.close(1000);
    manager.disable();
    context.disable();
    propagation.disable();
    trace.disable();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await sink.close();
  }
});
