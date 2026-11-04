# agentrail-node

Node 22+ backend evidence for Agentrail: HTTP and fetch traces, application-verified identity, explicit journey milestones and structured logs. Uses OpenTelemetry's HTTP/protobuf exporters. The receiver must support `/ingest/otlp/v1/traces` and `/ingest/otlp/v1/logs` before installing this package.

## Standalone startup

```ts
// instrumentation.ts — load before application HTTP modules
import { init } from 'agentrail-node';

export const agentrail = await init({
  collector: {
    endpoint: 'https://api.example.com/ingest/otlp',
    secret: process.env.AGENTRAIL_SOURCE_SECRET!, // a Node source
  },
  hashKey: process.env.AGENTRAIL_HASH_KEY!,
  serviceName: 'orders-api',
  outboundOrigins: ['https://inventory.internal'],
  onError(error) {
    console.error(error);
  },
});
```

The application validates its environment before initialization. Source credentials and the workspace hash key stay on the server. Never put them in a page. Start with `node --import ./instrumentation.js app.js`. `init` installs one tracer provider, logger provider, async context manager and HTTP/fetch instrumentation. Calling it again with the same options object returns the same client. It refuses an existing provider/context/propagator; use construction-time integration below. Shutdown is terminal for this installation.

A valid edge handoff continues its trace. Direct public calls and refused handoffs start fresh traces; a caller's trace is a directional link only. The HMAC binds method, exact forwarded path/query, parent, workspace key ID and a 60-second issue time. Keep clocks synchronized. Configure edge path/query rewrites with its `prepareOriginRequest` hook before signing. Arbitrary baggage and trace state do not leave managed requests. Only exact `outboundOrigins` receive signed context; the actual network destination determines admission, rather than an overridden Host header. Configure the same workspace key at each participating service. Exporter requests and this collector's incoming ingestion traffic are excluded.

## Verified context and milestones

```ts
// After authenticating the application request:
agentrail.identify({
  kind: 'agent_registration',
  id: authenticatedAgent.id,
  actingUserId: authenticatedAgent.userId,
});

const result = await agentrail.milestone(
  'checkout.confirm',
  { surface: 'custom', kind: 'checkout.confirm' },
  async () => confirmOrder(),
);
```

`identify` uses the active managed request, hashes IDs before export and never promotes generic OTel `user.id` or caller-declared attributes into verified identity. Outside a managed request it reports a capture error. Repeated identical assertions do nothing. A different assertion creates a distinct auth milestone while preserving the first principal. Concurrent requests have independent identity state. `milestone(name, context)` records an instant step; its callback overload scopes child spans, preserves the callback's result and rethrows its original error. Milestone names and kinds are bounded to 256 characters and should be stable operation names, without arguments or identifiers.

## Structured logs

```ts
import pinoLogger from 'pino';
import { pino } from 'agentrail-node/pino';
const logger = pinoLogger({ hooks: pino(agentrail) });
logger.error({ err: new TypeError('private detail') }, 'private detail');

agentrail.log({
  severityNumber: 17,
  errorType: 'PaymentDeclined',
  eventName: 'checkout.failed',
});
```

The optional Pino 9/10 hook captures synchronously in the caller's async context and composes an existing hook as its second argument. The original logger output is unchanged. The standard OTel log processor is also available. Default exports contain severity, error type, event name, a stable per-record ID and exact span correlation. Arguments, results, headers, arbitrary attributes, exception messages and message bodies are excluded. Generic logs never create journey proof. Set `logs.uncorrelated: false` to exclude logs outside managed requests.

Message text requires an explicit field allowlist, for example `logs: { includeFields: ['msg'] }` for Pino or `['message']` for a standard OTel body. `client.log` selects from `fields`. Only selected top-level scalar fields are serialized, with a 4096-character body limit. Do not select credentials, raw identities or sensitive customer content. Span names for supporting operations are neutralized, exception events and status messages are dropped, URLs retain only the `h` marker query, and resource exports contain service/component/hash-key metadata. Service names/instance IDs, routes, operation names, user agents and explicitly selected fields are customer-controlled context: choose non-sensitive values.

## Existing OpenTelemetry provider

Create the processors **before** constructing the customer's provider. A running provider cannot recover spans its sampler already dropped.

```ts
import { createProcessors } from 'agentrail-node';
import {
  TracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';

const capture = createProcessors(options);
const provider = new TracerProvider({
  sampler: capture.sampler(
    new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(0.1) }),
  ),
  spanProcessors: [customerProcessor, capture.spanProcessor],
});
const logProvider = new LoggerProvider({
  processors: [customerLogProcessor, capture.logProcessor],
});
// In the existing startup, register provider/logProvider, its async context manager,
// capture.propagator and these request-aware hooks once:
const http = new HttpInstrumentation(capture.httpOptions);
const fetch = new UndiciInstrumentation(capture.undiciOptions);
http.setTracerProvider(provider);
fetch.setTracerProvider(provider);
```

Retain other customer instrumentation; install only one HTTP and one Undici instrumentation, passing these options to them. Keep the request-aware propagator and HTTP hooks together: extraction alone cannot verify method and path. The factory registers no globals and never changes another exporter's input. The sampler promotes dropped managed spans to **record-only**, preserving the customer's sampled flag. Standard sampled-only exporters retain their sampling; custom exporters that export record-only spans may see additional records. Without this sampler wrapper, dropped entries report `entry_not_recording`, and their ancestry is unavailable. Ordinary spans outside managed requests are not captured by the Agentrail span processor.

Pinned compatible OTel family: API 1.9.1, core/trace/resources/context 2.10.0, logs/exporters/HTTP instrumentation 0.221.0, Undici instrumentation 0.31.0. This release supports those APIs; check dependency compatibility when composing a distribution.

## Delivery and shutdown

Defaults per signal: 2048 records including the in-flight batch, batches of 128, a 1000 ms schedule, 5000 ms export timeout, and 10000 ms flush/shutdown deadlines. Override with `queue`. Positive integer limits are required, batch size cannot exceed capacity and flush/shutdown deadlines cannot be shorter than the export timeout. One batch is in flight per signal. The official exporter retries retryable OTLP responses within its export deadline; permanent rejections and exhausted retries are reported and dropped. This is a bounded memory queue, without disk persistence.

`await agentrail.flush()` drains capture within the configured bound. `await agentrail.shutdown()` stops instrumentation and drains once; call it during application shutdown. `diagnostics()` reports accepted, exported, dropped and pending records per signal. Overflow, export failure, deadline loss, refused handoff and missing capture context go to `onError` (console by default). These capture outcomes do not replace an application response. Flush completion means attempts ended; inspect diagnostics/errors for delivery loss.
