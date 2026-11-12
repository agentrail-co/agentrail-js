# agentrail-node

The Agentrail SDK for Node backends. It records what happens on your server
when an agent or a person reaches it: incoming HTTP requests and the `fetch`
and HTTP calls they make, the identity your application has verified, the
milestones you name, structured logs and MCP tool calls. Agentrail links these
steps with the ones your edge and pages record, into one journey.

It is built on OpenTelemetry and sends OTLP HTTP/protobuf to the Agentrail
collector. Arguments, results, bodies, headers and raw identities never leave
your process.

- Node 22 or later
- Full guide: [Install the Node SDK](https://www.agentrail.co/docs/guides/journeys-node)
- The same features in other languages: [Go](https://github.com/agentrail-co/agentrail-go)
  and [Python](https://github.com/agentrail-co/agentrail-python)

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Install

```sh
npm install agentrail-node
```

In Agentrail, open your workspace's journey setup and create a backend source.
The setup screen calls it **Node**; the Go and Python SDKs use the same kind.
Copy its source secret, the workspace hash key and the collector address. Keep
the secret and the hash key on the server: never put them in a page.

## Quickstart

**1. Start Agentrail before your application's HTTP modules load.**

```ts
// instrumentation.ts
import { init } from 'agentrail-node';

const secret = process.env.AGENTRAIL_SOURCE_SECRET;
const hashKey = process.env.AGENTRAIL_HASH_KEY;
if (!secret || !hashKey) throw new Error('Agentrail credentials are not set');

export const agentrail = await init({
  collector: {
    endpoint: 'https://<collector>/ingest/otlp',
    secret,
  },
  hashKey,
  serviceName: 'orders-api',
  outboundOrigins: ['https://inventory.internal'],
  onError(error) {
    console.error(error);
  },
});
```

```sh
node --import ./instrumentation.js app.js
```

Every incoming HTTP request is now recorded, along with the HTTP and `fetch`
calls made while handling it.

**2. Say who the caller is, once your application has authenticated them.**

```ts
agentrail.identify({
  kind: 'agent_registration',
  id: authenticatedAgent.id,
  actingUserId: authenticatedAgent.userId,
});
```

**3. Name the steps that matter.**

```ts
const order = await agentrail.milestone(
  'checkout.confirm',
  { surface: 'custom', kind: 'checkout.confirm' },
  async () => confirmOrder(),
);
```

**4. Drain on shutdown.**

```ts
process.on('SIGTERM', () => {
  // Stop accepting requests, let handlers finish, then drain capture.
  server.close(() => void agentrail.shutdown());
});
```

## Options

| Option                  | Required | What it does                                                                                                                              |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `collector.endpoint`    | yes      | The collector's OTLP base URL, http(s), without credentials, query or fragment. The SDK adds `/v1/traces` and `/v1/logs`.                 |
| `collector.secret`      | yes      | The backend (**Node**) source's secret.                                                                                                   |
| `hashKey`               | yes      | The workspace hash key. Identities and operation references are hashed with it before export.                                             |
| `serviceName`           | yes      | A stable, non-sensitive name for this service. Well-formed text, at most 4096 characters.                                                 |
| `serviceInstanceId`     | no       | This process's ID. A random UUID by default.                                                                                              |
| `outboundOrigins`       | no       | Exact http(s) origins, such as `https://inventory.internal`, that receive signed trace context. None by default.                          |
| `ignoreIncomingRequest` | no       | `(request) => boolean`. Requests it returns `true` for are not recorded. See [Your own servers](#your-own-servers).                       |
| `incomingLocation`      | no       | `(request) => location \| null`. An approximate location for each request. See [Approximate IP location](#approximate-ip-location).       |
| `logs.includeFields`    | no       | Log fields whose values may be exported, in order. None by default. See [Structured logs](#structured-logs).                              |
| `logs.uncorrelated`     | no       | `false` leaves out logs written outside a managed request. `true` by default.                                                             |
| `queue`                 | no       | Delivery limits. See [Delivery and shutdown](#delivery-and-shutdown).                                                                     |
| `onError`               | no       | `(error: CaptureError) => void`. Told of every capture problem. Writes to the console by default.                                         |
| `propagator`            | no       | Only with `createProcessors`: your existing `TextMapPropagator`. See [Existing OpenTelemetry provider](#existing-opentelemetry-provider). |

Invalid options throw a `ConfigurationError` from `init` or `createProcessors`.
Validate your environment before calling them.

## How `init` installs

`init` installs one tracer provider, one logger provider, an async context
manager and the HTTP and `fetch` (Undici) instrumentation. Calling it again with
the same options object returns the same client; calling it with different
options throws. It refuses to replace an existing provider, context manager or
propagator: if another library owns OpenTelemetry in your process, use
[`createProcessors`](#existing-opentelemetry-provider) instead. Shutdown is
terminal for the installation.

## Trace handoff from the edge

When [`agentrail-edge`](https://github.com/agentrail-co/agentrail-js/tree/main/packages/edge) runs in front of this service, it signs each
request it forwards. A valid handoff continues the edge's trace, so the
request's steps join the visit the edge recorded. Direct public calls and
refused handoffs start a fresh trace; a caller's trace becomes a directional
link only.

The HMAC binds the method, the exact forwarded path and query, the trace
parent, the workspace key ID and an issue time valid for 60 seconds. So:

- configure the same workspace hash key at the edge and at every
  participating service;
- keep clocks synchronized;
- apply path and query rewrites in the edge's `prepareOriginRequest` hook,
  before it signs.

Arbitrary baggage and trace state do not leave managed requests. Only the exact
`outboundOrigins` receive signed context, and the real network destination
decides, not an overridden `Host` header. The SDK's own exports and the
collector's incoming ingestion traffic are excluded.

## Verified identity

```ts
agentrail.identify({ kind: 'user', id: session.userId });
```

Call `identify` inside the request, after your application has authenticated
the caller. `kind` is one of `user`, `agent_registration`, `agent_instance`,
`oauth_client` or `api_key`; `actingUserId` is optional.

- IDs are hashed with the workspace hash key before export.
- A generic OTel `user.id` attribute, or anything the caller declares, is never
  promoted to a verified identity.
- Repeating the same assertion does nothing. A different assertion records a
  separate auth milestone and keeps the first principal.
- Concurrent requests have independent identity state.
- Outside a managed request, `identify` reports `identity_outside_request` to
  `onError`.

## Milestones

```ts
agentrail.milestone('cart.viewed', { surface: 'custom', kind: 'cart.viewed' });

const result = await agentrail.milestone(
  'checkout.confirm',
  { surface: 'custom', kind: 'checkout.confirm' },
  async () => confirmOrder(),
);
```

Without a callback, `milestone` records an instant step. With one, it scopes
the callback's child spans, returns the callback's result and rethrows its
original error. Names and kinds are at most 256 characters: use stable
operation names, never arguments or identifiers. Outside a request, a
milestone starts its own managed operation.

### Workflow and plugin evidence

To track a business workflow (Agentrail's **Workflows** tracking), pass the
operation your application has authenticated and authorized:

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
      invocationId: crypto.randomUUID(),
    },
  },
});
```

- Use a new `instanceRef` for each new business attempt, and the same one for
  its start, progress, plugin invocations and backend outcome, across services.
  Those services must share the workspace hash key and the operation namespace.
  Source permissions are set in Agentrail.
- Emit a separate milestone with `role: 'terminal'` and the configured success
  event only after your backend has verified completion. A returned tool result
  or an HTTP 200 is not business completion.
- For a plugin invocation with no authorized operation, give only
  `environment` and `plugin`. It shows as plugin activity, with no workflow
  outcome credit.
- `production` and `test` are kept apart. A binding identifies an
  authenticated server deployment; it does not say which package version a
  ChatGPT or Claude host installed.

The operation reference is never exported. It is hashed with HMAC-SHA256 under
the workspace hash key, over the UTF-8 JSON
`["agentrail.operation", namespaceId, instanceRef]`, and the full digest is
exported with the hash-key ID. The domain separation keeps principal hashes and
other namespaces from becoming operation references. Do not put raw references
in milestone names, invocation IDs or log fields, and use an opaque
`invocationId`, never tool arguments or a customer identifier.

The SDK never propagates this evidence to unrelated child spans and never reads
arguments, results or a host conversation ID to invent it; the MCP adapter does
not infer operations or declare a result successful. Namespace and binding IDs
must be UUIDs. Invalid evidence is left out and reported as
`invalid_performance`; the milestone and your callback still run. Without
`performance`, capture is unchanged.

## Your own servers

Calls your own services make to this one are not visitors or agents. Leave
them out with `ignoreIncomingRequest`, and check something only your servers
can send, such as a shared secret: a user agent or an address is what any
caller can claim.

```ts
const internalSecret = process.env.INTERNAL_SECRET;
if (!internalSecret) throw new Error('INTERNAL_SECRET is not set');

await init({
  // ...
  ignoreIncomingRequest: (request) =>
    request.headers['x-my-internal'] === internalSecret,
});
```

Check the secret is set before `init`. Unset, a request with no such header
would match it, and every ordinary request would go unrecorded.

## Approximate IP location

```ts
await init({
  // ...
  incomingLocation: (request) => {
    const country = request.headers['cf-ipcountry'];
    return typeof country === 'string'
      ? { country, region: null, city: null, source: 'cloudflare' }
      : null;
  },
});
```

`incomingLocation(request)` runs synchronously for each captured incoming
request. Return `{ country, region, city, source }`, with `null` for unknown
place fields, or `null` when the address has no location.

- `country` is a two-letter uppercase code; `region` and `city` are at most 128
  characters.
- `source` is `cloudflare`, `vercel`, `dbip`, or `source` for another trusted
  provider.
- The four values are copied when the request arrives, so changing the returned
  object later cannot alter it.

Read trusted platform metadata, or a local database loaded before `init`; run
no network request in this hook. Resolve the original client address the way
your application's proxy configuration says, never from an arbitrary forwarded
header, and skip private and reserved addresses. The exporter connection's
address is not the visitor's.

The location is exported on managed entry spans without the address; the
collector adds the observation time. A thrown lookup error is reported as
`location_failed` and the request continues without a location. Without this
hook, no location is recorded. City-level results are approximate and can
describe a VPN or hosting provider rather than the person.

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

The optional Pino 9/10 hook captures synchronously in the caller's async
context and composes an existing hook passed as its second argument. Your
logger's own output is unchanged. The standard OTel log processor is also
available.

By default an exported log holds its severity, error type, event name, a stable
per-record ID and its exact span. Arguments, results, headers, arbitrary
attributes, exception messages and message bodies are left out. Logs never
create journey proof on their own.

To export message text, name the fields: `logs: { includeFields: ['msg'] }` for
Pino, `['message']` for a standard OTel body; `agentrail.log` selects from
`fields`. Only selected top-level scalar fields are serialized, in allowlist
order, into a body of at most 4096 characters. Strings are shortened before
serialization, counting JSON escaping and keeping whole code points; a field
that cannot fit is left out, so the body stays valid JSON. Never select
credentials, raw identities or sensitive customer content.

## MCP

```ts
import { McpServer, type ToolCallback } from '@modelcontextprotocol/server';
import { mcp } from 'agentrail-node/mcp';

const server = new McpServer({ name: 'orders', version: '1' });
const capture = mcp({ client: agentrail });

const checkout: ToolCallback = async (ctx) => {
  // Authentication happens in the application's HTTP or auth boundary.
  return { content: [{ type: 'text', text: 'done' }] };
};
server.registerTool('checkout', {}, capture.tool('checkout', checkout));
// capture.resource(name, handler) and capture.prompt(name, handler) wrap the
// other registration callbacks.
```

The optional adapter targets `@modelcontextprotocol/server` 2.3.1 and wraps
the public registration callbacks; it changes no private handler or transport.
Type a callback with the SDK's schema, for example
`ToolCallback<typeof inputSchema>`, to keep typed arguments.

- With HTTP capture installed, each call becomes a nested MCP step with its own
  span, exact log correlation and the request's verified identity. Outside an
  HTTP request it starts its own managed operation.
- It records the registered name, method, client name and version, protocol
  and whether the call failed. Arguments, result text, resource URIs and prompt
  content are left out. Pass a stable registered resource name, not the
  caller's URI.
- MCP 2026-07-28 metadata comes from the request's public context envelope.
  Legacy 2025-11-25 HTTP calls keep their protocol; a stateless server may have
  no client name after its discarded `initialize`. No initialize cache is kept
  across callers.
- Client info and trace metadata a caller sends stay untrusted and cannot
  assert a principal.
- An `isError` result marks the call failed and is returned unchanged; a thrown
  error keeps its identity.

Tested: modern tool, resource and prompt requests, and the official client's
legacy HTTP exchange. Other MCP SDK versions and transports are not verified in
this release.

## Existing OpenTelemetry provider

If your process already sets up OpenTelemetry, create the processors **before**
constructing your provider. A running provider cannot recover spans its sampler
already dropped.

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
// In your existing startup, register provider and logProvider, an async
// context manager, capture.propagator and these request-aware hooks, once:
const http = new HttpInstrumentation(capture.httpOptions);
const fetch = new UndiciInstrumentation(capture.undiciOptions);
http.setTracerProvider(provider);
fetch.setTracerProvider(provider);
// capture.client has identify, milestone, log, flush, shutdown and diagnostics.
```

- Pass your existing `TextMapPropagator` as `options.propagator`, then register
  the **returned** `capture.propagator` once. It delegates for unmanaged work
  and stops a late injection from re-adding headers to managed fetches. Keeping
  the original propagator globally bypasses this, because Undici injects after
  its request hook. For several installations, chain the earlier one's returned
  propagator as the next one's base.
- Keep other instrumentation, but install only one HTTP and one Undici
  instrumentation, with these options. Keep the propagator and the HTTP hooks
  together: extraction alone cannot verify the method and path.
- The factory registers no globals and never changes another exporter's input.
- The sampler promotes dropped managed spans to **record-only**, keeping your
  sampled flag. Sampled-only exporters keep their sampling; an exporter that
  exports record-only spans may see more records. Without the sampler wrapper,
  dropped entries report `entry_not_recording` and their ancestry is lost.
- Ordinary spans outside managed requests are not captured.

**Sentry.** Wrap `SentrySampler` with this sampler when constructing the single
provider you own, keep `SentrySpanProcessor` and its context manager, pass
`new SentryPropagator()` as the base propagator and register the returned
capture propagator globally. A 100% Sentry sample rate still drops HEAD and
OPTIONS, which a processor alone cannot recover. The package's install test
exercises this composition.

**Framework admission.** If a framework admits requests after authentication or
body parsing, use the request-aware incoming hook and propagator in the
admitted scope and turn off automatic incoming instrumentation, so each request
has one backend entry. Work before admission is not captured.

Pinned OpenTelemetry family: API 1.9.1; core, trace, resources and context
2.10.0; logs, exporters and HTTP instrumentation 0.221.0; Undici
instrumentation 0.31.0. Check compatibility when composing a distribution.

## Delivery and shutdown

| `queue` option      | Default | Meaning                                               |
| ------------------- | ------- | ----------------------------------------------------- |
| `maxRecords`        | 2048    | Records held per signal, the in-flight batch included |
| `batchSize`         | 128     | Records per export                                    |
| `scheduledDelayMs`  | 1000    | Time between scheduled exports                        |
| `exportTimeoutMs`   | 5000    | Deadline for one export, retries included             |
| `flushTimeoutMs`    | 10000   | Deadline for `flush()`                                |
| `shutdownTimeoutMs` | 10000   | Deadline for `shutdown()`                             |

Limits must be positive integers, `batchSize` cannot exceed `maxRecords`, and
the flush and shutdown deadlines cannot be shorter than `exportTimeoutMs`. One
batch is in flight per signal. The exporter retries retryable OTLP answers
within the export deadline; permanent rejections and exhausted retries are
reported and dropped. The queue is memory only, with no disk persistence.

- `await agentrail.flush()` drains capture within the configured bound. It means
  attempts ended, not that every record arrived.
- `await agentrail.shutdown()` stops instrumentation and drains once. Call it
  after your server stops accepting requests.
- `agentrail.diagnostics()` reports accepted, exported, dropped and pending
  records for spans and logs.

## Errors

Capture problems never replace your application's response. They go to
`onError` as a `CaptureError` with a `code`, a `signal` (`traces`, `logs` or
`context`) and a record `count`:

| Code                       | Meaning                                               |
| -------------------------- | ----------------------------------------------------- |
| `queue_full`               | The queue was full; records were dropped              |
| `export_failed`            | The collector refused, or retries ran out             |
| `deadline`                 | A flush, shutdown or export deadline passed           |
| `closed`                   | A record arrived after shutdown                       |
| `handoff_refused`          | A trace handoff did not verify; a fresh trace started |
| `entry_not_recording`      | A sampler dropped a managed entry span                |
| `location_failed`          | `incomingLocation` threw                              |
| `identity_outside_request` | `identify` was called outside a managed request       |
| `invalid_performance`      | Workflow or plugin evidence was invalid and left out  |

SDK error reporting runs outside capture, including when routed through the
same Pino or OTel logger, so diagnostics cannot feed their own full queue. If
your `onError` throws, both errors go to the console outside capture and queue
cleanup continues.

## What is exported

- Entry spans carry the method, route, status, user agent, the hashed verified
  principal and valid `h` markers on the URL; a sanitized URL over 4096
  characters is left out, and the entry and its trace evidence are kept.
- Supporting operation span names are neutralized; exception events and status
  messages are dropped.
- Resources carry the service, the component (`agentrail-node` and its version)
  and the hash-key ID.
- Service names and instance IDs, routes, operation names, user agents and the
  log fields you select are yours to choose: keep them non-sensitive.

## Licence

[Apache-2.0](LICENSE).
