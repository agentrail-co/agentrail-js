# agentrail-node

[![npm](https://img.shields.io/npm/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![Node](https://img.shields.io/node/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

The Agentrail SDK for Node servers. It records what happens on your server
when an agent or a person reaches it: the requests it answers and the HTTP and
`fetch` calls it makes, the identity your application verified, the milestones
you name, your logs and your MCP tool calls. [Agentrail](https://www.agentrail.co)
links these steps with the ones your edge and pages record, into one journey.

What leaves your process is each step's facts: a request's method, route,
status, user agent and URL (its query dropped, but for Agentrail's own
markers); an MCP call's method, tool or prompt name, resource URI (without its
userinfo, query or fragment), the client's self-reported name and version,
message sizes, JSON-RPC id and error code, and, for a call that came over
HTTP, the names of the request's headers with its `Accept` and
`Accept-Encoding`; and identities only as keyed hashes. Request and response
bodies, the values of other headers and raw identities never leave it.
MCP tool arguments and results are not exported unless you turn on
`capturePayloads`, and then only as your `redact` hook returns them. The same
features are in the
[Go](https://github.com/agentrail-co/agentrail-go) and
[Python](https://github.com/agentrail-co/agentrail-python) SDKs.

## Install

Node 22 or later.

```sh
npm install agentrail-node
```

In Agentrail, open **Journeys → Set up** and choose **Your servers**. Agentrail
shows the **Secret** and the **Hash key** once: keep them in your server's
secrets as `AGENTRAIL_SECRET` and `AGENTRAIL_HASH_KEY`, never in a page.

## Quick start

Start Agentrail before your application's HTTP modules load:

```ts
// instrumentation.ts
import { init } from 'agentrail-node';

const secret = process.env.AGENTRAIL_SECRET;
const hashKey = process.env.AGENTRAIL_HASH_KEY;
if (!secret || !hashKey) throw new Error('Agentrail is not configured');

export const agentrail = await init({
  collector: { endpoint: 'https://<collector>/ingest/otlp', secret },
  hashKey,
  serviceName: 'orders-api',
  outboundOrigins: ['https://inventory.example.com'], // your own services
});
```

```sh
node --import ./instrumentation.js app.js
```

Every request your server answers is now recorded, with the calls it makes.
In a handler, once your application has authenticated the caller:

```ts
agentrail.identify({ kind: 'user', id: user.id });

const order = await agentrail.milestone(
  'checkout.confirm',
  { surface: 'custom', kind: 'checkout.confirm' },
  async () => confirmOrder(),
);
```

When the process stops, finish your requests, then send what is queued:

```ts
process.on('SIGTERM', () => {
  server.close(() => void agentrail.shutdown());
});
```

`init` runs once per process: a second installation would record every
request twice, so a second call with the same options returns the same
client.

## Beside Sentry, Datadog and OpenTelemetry

The setup above is the same when your server already runs Sentry, Datadog
(`dd-trace`) or its own OpenTelemetry setup, and you change nothing in it.
Which starts first does not matter to Agentrail; `dd-trace` asks to be
loaded before anything else, and that works too.

- Agentrail keeps its own tracer and its own record of the request it is
  answering. It registers no OpenTelemetry global (tracer provider, context
  manager, propagator or logger provider) and never reads or changes yours,
  so your spans stay in your trace, under your server span, sampled and
  exported as before.
- The calls your server makes keep your tracer's headers (`traceparent`,
  `tracestate`, `baggage`, `sentry-trace`, `x-datadog-*`). Agentrail takes
  off only its own: the handoff it signs (`x-agentrail-trace-handoff`) and a
  CLI's `x-agentrail-cli`, which are meant for this server alone.
- On a call to one of your `outboundOrigins`, Agentrail sends its signed
  `traceparent` in place of yours, and leaves out your `tracestate`, which
  belonged to it. Your tracer's other headers go as they are, but your trace
  for that one call continues downstream under Agentrail's trace ID.
- Agentrail does not send your own spans (database calls and the like) or
  records written with the OpenTelemetry Logs API. Send logs with
  `agentrail.log` or the Pino hooks below.

## MCP servers

`agentrail-node/mcp` records every JSON-RPC message your MCP server receives
(`initialize`, `tools/list`, `tools/call`, notifications, and requests the SDK
refuses) as one step, through public APIs only: nothing is patched.

```ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { mcp } from 'agentrail-node/mcp';

const capture = mcp({ client: agentrail });

// A handler from createMcpHandler: serve the wrapped one in its place.
export const handler = capture.handler(
  createMcpHandler(() => {
    const server = new McpServer({ name: 'orders', version: '1' });
    server.registerTool(
      'find_order',
      { inputSchema },
      capture.tool('find_order', findOrder),
    );
    return server;
  }),
);

// A transport you own: connect the wrapped one.
await server.connect(capture.transport(transport));
```

If you create the handler with a larger `maxRequestBodySize` than
`createMcpHandler`'s 4 MiB default, give the wrapper the same value, or bodies
past 4 MiB are served without a step:
`capture.handler(createMcpHandler(factory, { maxRequestBodySize }), { maxRequestBodySize })`.

Each call carries its method and name, the client's self-reported name,
version and protocol, the keyed hash of its `Mcp-Session-Id` (none for a
stateless server), the size of the request and response as JSON, and its
JSON-RPC error code or `isError` result.

A call that came over HTTP also carries what its HTTP request said of
itself: the method, the URL (its query dropped, but for Agentrail's own
markers), the user agent, `Accept` and `Accept-Encoding`, the names of its
headers (never a value), and the call's JSON-RPC id; through `capture.handler`,
the HTTP status of the answer too. Every message of a batch carries its
request's. A client's HTTP library writes its headers in an order and case of
its own, which say which client it is: where `init` saw the request reach
your server, the names are sent as Node received them; otherwise they come
from the Fetch `Request`, which lower-cases and sorts them. Names are sent
as received, those a proxy added too: Agentrail leaves those out. A call
over stdio carries none of this.

`capture.tool`, `capture.resource`
and `capture.prompt` add the handler's own span inside the call, so a call is
counted once; on their own, without a wrapped transport, each is the step.
Inside a wrapped transport, a tool whose callback threw is a failed call: the
MCP server answers the throw with an `isError` result of its own, and the call
keeps `isError` but carries the thrown error's type, where a result your tool
returned with `isError` is a failed result (`tool_error`).

Payloads are off by default. To send them, redact first; returning `null`
sends neither:

```ts
const capture = mcp({
  client: agentrail,
  capturePayloads: {
    redact: ({ method, name, request, response }) =>
      name === 'find_order'
        ? { request, response: redactOrder(response) }
        : null,
  },
});
```

A payload is sent as JSON text with no length limit of its own, except that a
call's two payloads together are cut to 14 MiB of UTF-8 (the longer first, on a
character boundary, and flagged as truncated), so one call always fits an
export. At most 64 MiB of payload text waits to be sent: past that, calls go
without their payloads and `onError` is told (`payload_budget`), as it is when
`redact` throws or returns what JSON cannot hold (`payload_redact_failed`).

## Your CLI's calls

When your CLI uses [`agentrail-cli-sdk`](https://www.npmjs.com/package/agentrail-cli-sdk),
each request it makes to this server says which command an agent ran, in
which run and session. The SDK records that on the request's step, with the
session sent only as a keyed hash, so the agent's CLI runs join its journey.
Nothing to configure here.

## Documentation

| Topic                                                                                                                 | Guide                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Install, identity, milestones, logs (Pino), MCP, location                                                             | [Install the Node SDK](https://www.agentrail.co/docs/guides/journeys-node)              |
| Every option, running beside Sentry, Datadog or OpenTelemetry, delivery and errors, the MCP and Pino adapters in full | [Node SDK reference](https://www.agentrail.co/docs/guides/journeys-node-reference)      |
| Keeping your own services' calls out                                                                                  | [Leave out your own servers](https://www.agentrail.co/docs/guides/journeys-own-servers) |
| What is sent, and what never is                                                                                       | [What Agentrail records](https://www.agentrail.co/docs/guides/journeys-data)            |
| Workflow attempts and plugin calls                                                                                    | [Plugin workflow tracking](https://www.agentrail.co/docs/guides/plugin-performance)     |

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

### From 0.4

0.5 has one setup for everyone. `createProcessors` and the `propagator`
option are gone: where you wired Agentrail's processors, sampler,
propagator and HTTP options into your own OpenTelemetry setup, remove that
wiring and call `init` instead. `init` no longer refuses to start when
another tracer provider, context manager, propagator or logger provider is
installed.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
