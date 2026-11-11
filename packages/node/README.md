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

## Your own servers

Calls your own services make to this one are not visitors or agents. Leave
them out with `ignoreIncomingRequest`, and check something only your servers
can send, such as a shared secret: a user agent or an address is what any
caller can claim.

```ts
const internalSecret = process.env.INTERNAL_SECRET;
if (!internalSecret) throw new Error('INTERNAL_SECRET is not set');

init({
  // ...
  ignoreIncomingRequest: (request) =>
    request.headers['x-my-internal'] === internalSecret,
});
```

Check the secret is set before `init`. Unset, a request with no such header would match it, and every ordinary request would go unrecorded.

## Approximate IP location

To attach a location, supply `incomingLocation(request)` at startup. It runs
synchronously for each captured incoming HTTP request. Return
`{ country, region, city, source }`, with null for unavailable place fields,
or return null when the address has no location. Country is a two-letter
uppercase code; region and city are at most 128 characters. Source is
`cloudflare`, `vercel`, `dbip` or `source` for another trusted provider.
The hook's four values are copied when the request arrives, so reusing or
changing the returned object cannot alter an earlier request's location.

Use trusted platform metadata or a local database loaded before `init`.
Resolve the original client address according to your application's proxy
configuration; never trust an arbitrary forwarded header. Skip private and
reserved addresses. A thrown lookup error is reported to `onError` as
`location_failed`; the request continues without a location. No network
request should run in this hook. The SDK exports the location on managed entry
spans without the address, and the collector adds the observation time from
the entry span. The exporter connection's address is not the visitor's.
Without this hook, the SDK supplies no location. City-level results are
approximate and can describe a VPN or hosting provider instead of the user.

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

Message text requires an explicit field allowlist, for example `logs: { includeFields: ['msg'] }` for Pino or `['message']` for a standard OTel body. `client.log` selects from `fields`. Only selected top-level scalar fields are serialized, with a 4096-character body limit. Fields are considered in allowlist order. String values are shortened before serialization, including JSON escaping and complete Unicode code points; fields whose keys or scalar values cannot fit are omitted, so the exported object stays valid JSON. Do not select credentials, raw identities or sensitive customer content. Span names for supporting operations are neutralized, exception events and status messages are dropped, URLs retain only valid `h` markers; a sanitized URL over 4096 characters is omitted while the entry and its trace evidence are retained, and resource exports contain service/component/hash-key metadata. Service names/instance IDs, routes, operation names, user agents and explicitly selected fields are customer-controlled context: choose non-sensitive values.

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

const capture = createProcessors({
  ...options,
  propagator: customerPropagator,
});
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

Pass the existing `TextMapPropagator` as `options.propagator`, then register the **returned** `capture.propagator` once. It delegates extraction/injection for unmanaged work and prevents a late customer injection from re-adding headers to managed fetches. Keeping the original propagator globally bypasses this boundary: Undici injects after its request hook. For multiple installations, chain the earlier installation's returned propagator as the next one's base. Request-aware hooks still bind the actual destination/method/target before signing.

Retain other customer instrumentation; install only one HTTP and one Undici instrumentation, passing these options to them. Keep the request-aware propagator and HTTP hooks together: extraction alone cannot verify method and path. The factory registers no globals and never changes another exporter's input. The sampler promotes dropped managed spans to **record-only**, preserving the customer's sampled flag. Standard sampled-only exporters retain their sampling; custom exporters that export record-only spans may see additional records. Without this sampler wrapper, dropped entries report `entry_not_recording`, and their ancestry is unavailable. Ordinary spans outside managed requests are not captured by the Agentrail span processor.

For Sentry, compose this sampler around `SentrySampler` while constructing the single customer-owned provider, retaining `SentrySpanProcessor` and its context manager, with `new SentryPropagator()` passed as the base and the returned capture propagator registered globally. A 100% Sentry sample rate still drops HEAD/OPTIONS; merely adding a processor cannot retain those spans. Agentrail's packed installation gate exercises this public composition. In framework admission mode, use the supplied request-aware incoming hook/propagator in the admitted scope and disable automatic incoming instrumentation, so there is one backend entry per request. Handler work after admission is captured; earlier authentication/body parsing is outside that scope.

Pinned compatible OTel family: API 1.9.1, core/trace/resources/context 2.10.0, logs/exporters/HTTP instrumentation 0.221.0, Undici instrumentation 0.31.0. This release supports those APIs; check dependency compatibility when composing a distribution.

## Delivery and shutdown

Defaults per signal: 2048 records including the in-flight batch, batches of 128, a 1000 ms schedule, 5000 ms export timeout, and 10000 ms flush/shutdown deadlines. Override with `queue`. Positive integer limits are required, batch size cannot exceed capacity and flush/shutdown deadlines cannot be shorter than the export timeout. One batch is in flight per signal. The official exporter retries retryable OTLP responses within its export deadline; permanent rejections and exhausted retries are reported and dropped. This is a bounded memory queue, without disk persistence.

`await agentrail.flush()` drains capture within the configured bound. `await agentrail.shutdown()` stops instrumentation and drains once; call it during application shutdown. `diagnostics()` reports accepted, exported, dropped and pending records per signal. Overflow, export failure, deadline loss, refused handoff and missing capture context go to `onError` (console by default). SDK error reporting runs outside capture, including when routed through the same Pino or OTel logger, so diagnostics cannot feed their own full queue. If a synchronous `onError` callback throws, its exception and the original capture error are reported to the console outside capture, and queue cleanup continues. These capture outcomes do not replace an application response. Flush completion means attempts ended; inspect diagnostics/errors for delivery loss.

## MCP callback adapter

```ts
import { McpServer, type ToolCallback } from '@modelcontextprotocol/server';
import { mcp } from 'agentrail-node/mcp';
const server = new McpServer({ name: 'orders', version: '1' });
const capture = mcp({ client: agentrail });
const checkout: ToolCallback = async (ctx) => {
  // Authentication happens in the application's HTTP/auth boundary.
  return { content: [{ type: 'text', text: 'done' }] };
};
server.registerTool('checkout', {}, capture.tool('checkout', checkout));
// capture.resource(registeredName, handler) and capture.prompt(registeredName, handler)
// wrap their respective public registration callbacks too.
```

The optional adapter targets `@modelcontextprotocol/server` 2.3.1 and public registration callbacks, without modifying private handlers or transports. Use a callback typed with the SDK's schema, for example `ToolCallback<typeof inputSchema>`, for typed tool arguments. With HTTP capture installed, each execution becomes a nested MCP step with a distinct span, exact log correlation and inherited application-verified identity. Outside an HTTP request, it starts its own managed operation. It captures the registered operation name, method, client name/version, protocol and error outcome; arguments, result text, resource URIs and prompt content stay off. Pass a stable registered resource name rather than the caller's URI.

MCP 2026-07-28 metadata comes from the request's public context envelope. Legacy 2025-11-25 HTTP calls retain protocol metadata; a stateless server may have no client name after its discarded initialize request. The adapter keeps no initialize cache across callers. Client info and supplied trace metadata remain untrusted and cannot assert a principal. `isError` results mark the operation as failed while preserving the original result. Thrown application errors retain their original identity. Tests exercise modern tool/resource/prompt requests and the official client's legacy HTTP exchange; other MCP SDK versions/transports have not been verified in this release.

## Explicit workflow and plugin evidence

After the application authenticates and authorizes a business operation, pass its
operation-instance reference to `milestone`. Use a different reference for each
new business attempt, and the same reference for its start, progress, plugin
invocations and backend outcome across services. Services must share the workspace
hash key and operation namespace. Source permissions are configured in Agentrail.

```ts
agentrail.milestone('delivery.requested', {
  surface: 'custom',
  kind: 'business.event',
  performance: {
    environment: 'production',
    operation: {
      namespaceId: configuredNamespaceId,
      instanceRef: authorizedDeliveryAttempt.id,
      role: 'start',
    },
    eventName: 'delivery.requested',
    plugin: {
      bindingId: configuredBindingId,
      invocationId: opaqueInvocationId,
    },
  },
});
```

Emit a separate milestone with role `terminal` and the configured success event
only after the backend verifies completion. A returned tool result or HTTP 200
is not business completion. The MCP adapter does not infer operation references
from arguments or automatically declare a result successful.

The operation reference is HMAC-SHA256 hashed before entering telemetry context;
the full digest is exported. The input is the UTF-8 JSON encoding of
`["agentrail.operation", namespaceId, instanceRef]`, with the workspace hash key
as the HMAC key. This domain separation prevents principal hashes or other
namespaces from becoming operation references. The SDK exports the hash-key ID
alongside the hash, never the key or raw operation reference. Do not place raw
references in milestone names, invocation IDs, or log fields.

For an invocation without an authorized operation, supply only `environment` and
`plugin`. It remains visible as plugin activity without workflow-outcome credit.
The SDK never propagates this assertion to unrelated child spans and never reads
arguments, results or a host conversation ID to invent it. Production and test
are separate. A binding identifies an authenticated server deployment; it does
not establish which package version a ChatGPT or Claude host installed.

This hook requires a collector that accepts explicit plugin/workflow attributes.
Upgrade the collector before enabling the hook. Existing capture is unchanged
when `performance` is omitted. No package is published by this change alone.

Invalid per-call performance evidence is omitted and reported through `onError` as `invalid_performance`; the milestone and customer callback still run. Namespace and binding IDs must match the collector UUID contract. Use an opaque invocation ID, such as `crypto.randomUUID()`, never tool arguments or a customer identifier. Operation references are hashed locally, including any valid Unicode or NUL characters; they are never exported.
