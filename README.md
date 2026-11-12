# Agentrail SDKs for JavaScript

[![CI](https://github.com/agentrail-co/agentrail-js/actions/workflows/ci.yml/badge.svg)](https://github.com/agentrail-co/agentrail-js/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

[Agentrail](https://www.agentrail.co) follows the journeys AI agents and people
take through your product: the docs page an agent read, the link it followed,
the API it called, the sign-up it finished. These packages record each step
where it happens and send it to Agentrail, which links the steps into journeys.

## Which package do I need?

| Package                                                                | Version                                                                                                   | Use it for                                                                                                    |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`agentrail-edge`](https://www.npmjs.com/package/agentrail-edge)       | [![npm](https://img.shields.io/npm/v/agentrail-edge)](https://www.npmjs.com/package/agentrail-edge)       | Every request to your site, including agents that never run JavaScript. Cloudflare Workers, Vercel, Fetch API |
| [`agentrail-browser`](https://www.npmjs.com/package/agentrail-browser) | [![npm](https://img.shields.io/npm/v/agentrail-browser)](https://www.npmjs.com/package/agentrail-browser) | Page views, your pages' own calls and WebMCP tool calls. Most sites use the hosted tag instead                |
| [`agentrail-node`](https://www.npmjs.com/package/agentrail-node)       | [![npm](https://img.shields.io/npm/v/agentrail-node)](https://www.npmjs.com/package/agentrail-node)       | Your Node servers: requests, verified identity, milestones, logs and MCP calls                                |
| [`agentrail-core`](https://www.npmjs.com/package/agentrail-core)       | [![npm](https://img.shields.io/npm/v/agentrail-core)](https://www.npmjs.com/package/agentrail-core)       | What the others share. Only for building a component of your own                                              |

Start with the edge if agents read your site, add the browser tag for pages
people and browser agents use, and add a server SDK where the real work
happens. Servers in other languages: [Go](https://github.com/agentrail-co/agentrail-go)
and [Python](https://github.com/agentrail-co/agentrail-python), with the same features.

Each package needs Node 22 or later to install. Your credentials come from
**Journeys → Set up** in Agentrail.

## Quick start

**Edge, on Cloudflare Workers** (`npm install agentrail-edge`):

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

**Browser tag**, with the public key Agentrail gives you:

```html
<script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
```

**Node server** (`npm install agentrail-node`), loaded with
`node --import ./instrumentation.js app.js`:

```ts
import { init } from 'agentrail-node';

export const agentrail = await init({
  collector: {
    endpoint: 'https://<collector>/ingest/otlp',
    secret: process.env.AGENTRAIL_SECRET!,
  },
  hashKey: process.env.AGENTRAIL_HASH_KEY!,
  serviceName: 'orders-api',
});
```

## Documentation

- [Journeys](https://www.agentrail.co/docs/guides/journeys): what a journey is, and setting up sources
- [Install the edge](https://www.agentrail.co/docs/guides/journeys-edge)
- [Install the browser script](https://www.agentrail.co/docs/guides/journeys-browser)
- [Install the Node SDK](https://www.agentrail.co/docs/guides/journeys-node)
- [Leave out your own servers](https://www.agentrail.co/docs/guides/journeys-own-servers)
- [What Agentrail records](https://www.agentrail.co/docs/guides/journeys-data)

The four packages share one version. Before 1.0, a minor version (0.1 to 0.2)
may change what they offer.

## Support

Questions and bugs: [GitHub issues](https://github.com/agentrail-co/agentrail-js/issues).
To report a security problem, open an issue asking for a private contact,
without the details. To work on the packages, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE).
