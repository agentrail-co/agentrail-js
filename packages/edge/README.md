# agentrail-edge

[![npm](https://img.shields.io/npm/v/agentrail-edge)](https://www.npmjs.com/package/agentrail-edge)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

The Agentrail edge runs in front of your site on Cloudflare Workers, Vercel
Routing Middleware or any Fetch API runtime. It records every request,
including those from agents that never run JavaScript, and marks the links in
answers meant for agents (Markdown, `llms.txt`), so the next request an agent
makes is joined to the page it came from.

Recording happens after the answer, so a visitor never waits for it and never
sees it fail. A visitor's address and any verified identity leave the edge only
as keyed hashes.

## Install

```sh
npm install agentrail-edge
```

In Agentrail, open **Journeys → Set up** and choose **Edge**. Agentrail shows
the **Secret** and the **Hash key** once: keep them in your platform's
secrets as `AGENTRAIL_SECRET` and `AGENTRAIL_HASH_KEY`.

## Quick start: Cloudflare Workers

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
      hosts: { 'docs.example.com': 'query' }, // your own hosts
    });
    return edge.handle(request, cloudflare(ctx));
  },
};
```

Create the edge once, on the first request, as this does: the requests an
isolate answers then share calls to the collector. On Vercel, use
`vercel({ waitUntil, origin })` in Routing Middleware; the guide has the full
example.

## Documentation

| Topic                                                                | Guide                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Cloudflare and Vercel setup, every option, identifying a caller      | [Install the edge](https://www.agentrail.co/docs/guides/journeys-edge)                  |
| Handing the trace to your servers, and rewriting paths before it     | [Install the edge](https://www.agentrail.co/docs/guides/journeys-edge)                  |
| Keeping your own servers' calls out (`ignoreRequest`)                | [Leave out your own servers](https://www.agentrail.co/docs/guides/journeys-own-servers) |
| What each request records, including the caller's facts and location | [What Agentrail records](https://www.agentrail.co/docs/guides/journeys-data)            |

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
