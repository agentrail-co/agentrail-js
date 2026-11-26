import * as Sentry from '@sentry/node';
import { expect, it } from 'vitest';
import { init } from '../src/index.js';
import {
  APP_TRACESTATE,
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

interface Transaction {
  readonly contexts: {
    readonly trace: {
      trace_id: string;
      span_id: string;
      parent_span_id?: string;
    };
  };
  readonly spans: readonly { op?: string; parent_span_id?: string }[];
}
function transactions(envelopes: readonly unknown[]): Transaction[] {
  return envelopes.flatMap((envelope) => {
    const [, items] = envelope as [unknown, [{ type: string }, unknown][]];
    return items.flatMap(([header, event]) =>
      header.type === 'transaction' ? [event as Transaction] : [],
    );
  });
}

// Fails if init registers an OpenTelemetry global (Sentry's own setup could
// not install, and its transaction would never arrive), puts the SDK's span
// into OpenTelemetry's context (Sentry's calls would carry the SDK's trace
// and hang under it), or strips Sentry's headers from the calls again.
it('runs beside a default Sentry setup started after it', async () => {
  const sink = await collector();
  const ordinary = await downstream();
  const allowed = await downstream();
  const sdk = await init({
    ...options(sink.endpoint),
    outboundOrigins: [allowed.origin],
    // The services the application calls are someone else's.
    ignoreIncomingRequest: (request) =>
      [ordinary.port, allowed.port].includes(request.socket.localPort ?? 0),
  });
  const app = await application(sdk, ordinary.origin, allowed.origin);
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
  const caller = '00f067aa0ba902b7';
  const incoming = {
    'sentry-trace': `${traceId}-${caller}-1`,
    baggage: `sentry-trace_id=${traceId},sentry-sampled=true,sentry-sample_rate=1`,
    'x-agentrail-cli': CLI_VALUE,
  };
  const envelopes: unknown[] = [];
  try {
    // The same request, first with Agentrail alone.
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();
    const alone = shape(sink.spans());
    const before = sink.spans().length;
    ordinary.seen.clear();
    allowed.seen.clear();
    Sentry.init({
      dsn: 'https://public@synthetic.invalid/1',
      tracesSampleRate: 1,
      transport: () => ({
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({});
        },
        flush: () => Promise.resolve(true),
      }),
    });
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();
    await Sentry.flush(2000);

    const made = calls(ordinary.seen, allowed.seen);
    const all = Object.values(made);
    expect(all.every((call) => call !== undefined)).toBe(true);
    // (1) Sentry continued the caller's trace through the SDK's capture.
    for (const call of all)
      expect(call?.headers['sentry-trace']).toMatch(
        new RegExp(`^${traceId}-[0-9a-f]{16}-1$`, 'u'),
      );
    // The application's own, under the caller (the services it calls are traced too).
    const transaction = transactions(envelopes).find(
      (each) => each.contexts.trace.parent_span_id === caller,
    );
    expect(transaction?.contexts.trace.trace_id).toBe(traceId);
    const clientSpans = transaction?.spans.filter(
      (span) => span.op === 'http.client',
    );
    expect(clientSpans).toHaveLength(4);
    expect(
      clientSpans?.every(
        (span) => span.parent_span_id === transaction?.contexts.trace.span_id,
      ),
    ).toBe(true);
    // (2) Sentry's headers go everywhere; the SDK's own only to the allowed origin.
    for (const call of all) {
      expect(call?.headers.baggage).toContain(`sentry-trace_id=${traceId}`);
      expect(call?.headers['x-agentrail-cli']).toBeUndefined();
    }
    for (const call of [made.ordinaryFetch, made.ordinaryRequest]) {
      expect(call?.handoff).toBe('missing');
      expect(call?.headers.traceparent).toBeUndefined();
      expect(call?.headers.tracestate).toBe(APP_TRACESTATE);
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
    }
    // (3) The collector got what it got without Sentry.
    expect(shape(sink.spans().slice(before))).toEqual(alone);
  } finally {
    await Sentry.close(1000);
    await sdk.shutdown();
    await app.close();
    await ordinary.close();
    await allowed.close();
    await sink.close();
  }
});
