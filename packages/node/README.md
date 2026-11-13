# agentrail-node

[![npm](https://img.shields.io/npm/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![Node](https://img.shields.io/node/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

The Agentrail SDK for Node servers. It records what happens on your server
when an agent or a person reaches it: the requests it answers and the HTTP and
`fetch` calls it makes, the identity your application verified, the milestones
you name, your logs and your MCP tool calls. [Agentrail](https://www.agentrail.co)
links these steps with the ones your edge and pages record, into one journey.

Request bodies, headers and raw identities never leave your process. MCP tool
arguments and results are not exported unless you turn on `capturePayloads`,
and then only as your `redact` hook returns them. The same features are in the
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

Each call carries its method and name, the client's self-reported name,
version and protocol, the keyed hash of its `Mcp-Session-Id` (none for a
stateless server), the size of the request and response as JSON, and its
JSON-RPC error code or `isError` result. `capture.tool`, `capture.resource`
and `capture.prompt` add the handler's own span inside the call, so a call is
counted once; on their own, without a wrapped transport, each is the step.

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

A payload is sent as JSON text with no length limit of its own; one is cut
only when the call would not fit a single 16 MiB export, and then flagged as
truncated. At most 64 MiB of payload text waits to be sent: past that, calls
go without their payloads and `onError` is told (`payload_budget`), as it is
when `redact` throws (`payload_redact_failed`).

## Documentation

| Topic                                                                                                              | Guide                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Install, identity, milestones, logs (Pino), MCP, location                                                          | [Install the Node SDK](https://www.agentrail.co/docs/guides/journeys-node)              |
| Every option, an existing OpenTelemetry setup (Sentry too), delivery and errors, the MCP and Pino adapters in full | [Node SDK reference](https://www.agentrail.co/docs/guides/journeys-node-reference)      |
| Keeping your own services' calls out                                                                               | [Leave out your own servers](https://www.agentrail.co/docs/guides/journeys-own-servers) |
| What is sent, and what never is                                                                                    | [What Agentrail records](https://www.agentrail.co/docs/guides/journeys-data)            |
| Workflow attempts and plugin calls                                                                                 | [Plugin workflow tracking](https://www.agentrail.co/docs/guides/plugin-performance)     |

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
