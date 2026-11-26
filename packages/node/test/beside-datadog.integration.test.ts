import tracer from 'dd-trace';
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

// Datadog starts first, as it asks to (`--require dd-trace/init`), sending
// to an agent that is not there.
process.env.DD_REMOTE_CONFIGURATION_ENABLED = 'false';
process.env.DD_INSTRUMENTATION_TELEMETRY_ENABLED = 'false';
tracer.init({
  url: 'http://127.0.0.1:9',
  startupLogs: false,
  runtimeMetrics: false,
  plugins: true,
});
const plugins = ['http', 'fetch'] as const;

// Fails if the SDK's subscribers or wrappers break dd-trace's request scope
// (its x-datadog-trace-id would stop continuing on the calls the request
// makes), or if dd-trace's own patching hides requests or calls from the SDK.
it('runs beside dd-trace started before it', async () => {
  for (const plugin of plugins) tracer.use(plugin, { enabled: false });
  const sink = await collector();
  const ordinary = await downstream();
  const allowed = await downstream();
  const sdk = await init({
    ...options(sink.endpoint),
    outboundOrigins: [allowed.origin],
    ignoreIncomingRequest: (request) =>
      [ordinary.port, allowed.port].includes(request.socket.localPort ?? 0),
  });
  const app = await application(sdk, ordinary.origin, allowed.origin);
  const traceId = '1234567890123456789';
  const incoming = {
    'x-datadog-trace-id': traceId,
    'x-datadog-parent-id': '987654321987654321',
    'x-datadog-sampling-priority': '1',
    'x-agentrail-cli': CLI_VALUE,
  };
  try {
    // The same request, with Datadog's tracing off.
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();
    const alone = shape(sink.spans());
    const before = sink.spans().length;
    ordinary.seen.clear();
    allowed.seen.clear();
    for (const plugin of plugins) tracer.use(plugin, { enabled: true });
    expect(await arrive(`${app.origin}/checkout`, incoming)).toBe(OK);
    await sdk.flush();

    const made = calls(ordinary.seen, allowed.seen);
    const all = Object.values(made);
    expect(all.every((call) => call !== undefined)).toBe(true);
    // (1) dd-trace continued the caller's trace on every call.
    for (const call of all)
      expect(call?.headers['x-datadog-trace-id']).toBe(traceId);
    for (const call of [made.ordinaryFetch, made.ordinaryRequest]) {
      expect(call?.headers.traceparent).toBeDefined();
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
    // (3) The collector got what it got with Datadog's tracing off: the
    // request, its milestone and all four calls.
    const beside = shape(sink.spans().slice(before));
    expect(beside).toEqual(alone);
    expect(beside).toHaveLength(6);
  } finally {
    await sdk.shutdown();
    await app.close();
    await ordinary.close();
    await allowed.close();
    await sink.close();
  }
});
