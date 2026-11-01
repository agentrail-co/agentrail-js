# agentrail-edge

The Agentrail edge, in front of a site on the Fetch API: Cloudflare Workers,
Vercel Routing Middleware, or anything else that speaks it. Each request is
answered through the site's origin and recorded as one event, sent to the
Agentrail collector after the answer through the platform's `waitUntil`, so
recording never slows a request.

In an answer meant for agents (Markdown, `llms.txt`), every link to the
site's own hosts is marked, so the request an agent makes by following one
is joined to the page it came from. The marker comes off before the origin
sees the request. A visitor's address, and any verified principal, leave
the edge only hashed with the workspace's hash key.

> Pre-release: not on npm yet.

## Cloudflare Workers

The secret and the hash key come from Agentrail's setup page, as the
`AGENTRAIL_SECRET` and `AGENTRAIL_HASH_KEY` environment variables; the
collector's address is the one the setup page shows.

```js
import { cloudflare, createEdge } from 'agentrail-edge';

export default {
  fetch(request, env, ctx) {
    const edge = createEdge({
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

## Vercel

In Routing Middleware, `vercel({ waitUntil, origin })` takes `waitUntil`
from `@vercel/functions` and fetches the site itself, since middleware cannot
rewrite an answer it passes on.

## Options

- `hosts`: the site's own hosts, and how a link to each is marked: `'query'`
  adds the `h` parameter, `'path'` an `/h/<marker>` prefix, for a host whose
  calls an extra parameter would break.
- `queryAllowlist`: query parameters a recorded path keeps; every other is
  dropped, and named as dropped.
- `identify(request)`: the verified principal behind a request, by the site's
  own check of its method, URL and headers. It runs after the answer.
- `sessionCookie`, `service`, `fetch`: the session cookie's name, the
  service the events name, and the fetch the collector's calls go through.
- `onError(error)`: told of events that could not be sent; they are logged
  otherwise. A failure to send never reaches the visitor.

## Licence

[Apache-2.0](LICENSE).
