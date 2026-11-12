# agentrail-node

[![npm](https://img.shields.io/npm/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![Node](https://img.shields.io/node/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

The Agentrail SDK for Node servers. It records what happens on your server
when an agent or a person reaches it: the requests it answers and the HTTP and
`fetch` calls it makes, the identity your application verified, the milestones
you name, your logs and your MCP tool calls. [Agentrail](https://www.agentrail.co)
links these steps with the ones your edge and pages record, into one journey.

Bodies, arguments, results, headers and raw identities never leave your
process. The same features are in the [Go](https://github.com/agentrail-co/agentrail-go)
and [Python](https://github.com/agentrail-co/agentrail-python) SDKs.

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
