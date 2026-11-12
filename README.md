# Agentrail SDKs for JavaScript

Agentrail follows the journeys AI agents and people take through your product:
the docs page an agent read, the link it followed, the API it called, the
sign-up it finished. These packages record each step where it happens, in front
of your site, on its pages and on your servers, and send it to the Agentrail
collector, which links the steps into journeys.

Documentation: [agentrail.co/docs](https://www.agentrail.co/docs/guides/journeys)

## Which package do I need?

```
 agent or person
       │
       ▼
┌──────────────────┐   pages    ┌───────────────────┐
│  agentrail-edge  │ ─────────▶ │ agentrail-browser │  the script on your pages
│  in front of the │            └───────────────────┘
│  site (CDN/edge) │
└────────┬─────────┘
         │ signed trace handoff
         ▼
┌──────────────────┐
│  agentrail-node  │  your Node backend (or the Go and Python SDKs)
└──────────────────┘
```

| Package                                 | Use it for                                                                                                                                              | Runs on                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`agentrail-edge`](packages/edge)       | Recording every request to your site, including agents that only fetch pages, and marking the links in answers meant for agents (Markdown, `llms.txt`). | Cloudflare Workers, Vercel Routing Middleware, any Fetch API runtime |
| [`agentrail-browser`](packages/browser) | Page views, the trace on your pages' own calls, and WebMCP tool calls. Most sites use the hosted tag instead of installing this package.                | Browsers                                                             |
| [`agentrail-node`](packages/node)       | Backend HTTP and `fetch` traces, verified identity, milestones, workflow and plugin evidence, structured logs and MCP tool calls.                       | Node 22+                                                             |
| [`agentrail-core`](packages/core)       | What the others share. Only for building a component of your own.                                                                                       | Any Fetch API and WebCrypto runtime                                  |

Start with the edge if agents read your site, add the browser tag for pages
people and browser agents use, and add a backend SDK where the real work
happens: sign-ups, API calls, MCP tools.

## Install

```sh
npm install agentrail-edge      # in front of the site
npm install agentrail-node      # in the Node backend
npm install agentrail-browser   # only for a site that bundles the script itself
```

Every package needs Node 22 or later to install. Credentials come from your
workspace's journey setup in Agentrail: an **edge** source for the edge, a
**browser** source (public key) for the tag, and a backend source, called
**Node** on the setup screen, for the backend SDKs. Keep secrets and the
workspace hash key on the server.

## Quickstart

### Edge, on Cloudflare Workers

```js
import { cloudflare, createEdge } from 'agentrail-edge';

let edge;

export default {
  fetch(request, env, ctx) {
    edge ??= createEdge({
      collector: {
        endpoint: 'https://<collector>/ingest/events',
        secret: env.AGENTRAIL_SECRET,
      },
      hashKey: env.AGENTRAIL_HASH_KEY,
      hosts: { 'docs.example.com': 'query' },
    });
    return edge.handle(request, cloudflare(ctx));
  },
};
```

Vercel and other runtimes: [packages/edge](packages/edge) and the
[edge guide](https://www.agentrail.co/docs/guides/journeys-edge).

### Browser tag

```html
<script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
```

Options, consent and bundling: [packages/browser](packages/browser) and the
[browser guide](https://www.agentrail.co/docs/guides/journeys-browser).

### Node backend

```ts
// instrumentation.ts, loaded with: node --import ./instrumentation.js app.js
import { init } from 'agentrail-node';

export const agentrail = await init({
  collector: {
    endpoint: 'https://<collector>/ingest/otlp',
    secret: process.env.AGENTRAIL_SOURCE_SECRET!,
  },
  hashKey: process.env.AGENTRAIL_HASH_KEY!,
  serviceName: 'orders-api',
});

// In a request, after your application has authenticated the caller:
agentrail.identify({ kind: 'user', id: session.userId });
await agentrail.milestone(
  'checkout.confirm',
  { surface: 'custom', kind: 'checkout.confirm' },
  async () => confirmOrder(),
);
```

Everything else: [packages/node](packages/node) and the
[Node guide](https://www.agentrail.co/docs/guides/journeys-node).

## Backend SDKs in other languages

The Node, Go and Python SDKs record the same things and send the same data, so
a journey can cross services written in each.

| Feature                             | Node (`agentrail-node`) | Go (`agentrail-go`) | Python (`agentrail-python`) |
| ----------------------------------- | :---------------------: | :-----------------: | :-------------------------: |
| Incoming and outgoing HTTP traces   |            ✓            |          ✓          |              ✓              |
| Signed trace handoff from the edge  |            ✓            |          ✓          |              ✓              |
| Verified identity (`identify`)      |            ✓            |          ✓          |              ✓              |
| Milestones                          |            ✓            |          ✓          |              ✓              |
| Workflow and plugin evidence        |            ✓            |          ✓          |              ✓              |
| Structured logs                     |     ✓ (Pino, OTel)      |  ✓ (`slog`, OTel)   |     ✓ (`logging`, OTel)     |
| MCP tool, resource and prompt calls |            ✓            |          ✓          |              ✓              |
| Existing OpenTelemetry provider     |            ✓            |          ✓          |              ✓              |
| Approximate IP location             |            ✓            |          ✓          |              ✓              |
| Ignore your own servers' requests   |            ✓            |          ✓          |              ✓              |
| Bounded delivery and diagnostics    |            ✓            |          ✓          |              ✓              |

| Language | Install                                                    | Repository                                                                        |
| -------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Node     | `npm install agentrail-node`                               | this repository, [packages/node](packages/node)                                   |
| Go       | `go get github.com/agentrail-co/agentrail-go@v0.2.0`       | [agentrail-co/agentrail-go](https://github.com/agentrail-co/agentrail-go)         |
| Python   | `pip install agentrail-python` (`import agentrail_python`) | [agentrail-co/agentrail-python](https://github.com/agentrail-co/agentrail-python) |

## Guides

- [Journeys](https://www.agentrail.co/docs/guides/journeys): what a journey is
  and how to set up sources
- [Edge](https://www.agentrail.co/docs/guides/journeys-edge)
- [Browser](https://www.agentrail.co/docs/guides/journeys-browser)
- [Node](https://www.agentrail.co/docs/guides/journeys-node)
- [Your own servers](https://www.agentrail.co/docs/guides/journeys-own-servers):
  keeping your services' calls out of journeys
- [What is recorded](https://www.agentrail.co/docs/guides/journeys-data)

## Versioning

The four packages share one version. Before 1.0, a minor version (0.1 to 0.2)
may change what the packages offer; read the release notes before upgrading.

## Support and security

Questions and bugs: [GitHub issues](https://github.com/agentrail-co/agentrail-js/issues).
To report a security problem, open an issue asking for a private contact,
without the details.

## Development

```sh
pnpm install
pnpm build      # first: the edge and the browser read core's built types
pnpm lint
pnpm typecheck
pnpm test
```

## Releasing

The four packages share one version and are released together: a
`v<version>` tag publishes all four (`.github/workflows/release.yml`). A
version such as `0.2.0` goes to npm's `latest` tag, and a trial build such as
`0.2.0-dev.1` to `next`.

Only the repository's admins can push a `v*` tag, and the run then waits for
approval in the `npm` environment. npm trusts the workflow, so no token is
stored: each package's trusted publisher names `agentrail-co`,
`agentrail-js`, `release.yml` and the `npm` environment, and allows
`npm publish`. A run that published some packages and then failed can be
run again once the cause is fixed: it skips a version npm already has.

## Licence

[Apache-2.0](LICENSE).
