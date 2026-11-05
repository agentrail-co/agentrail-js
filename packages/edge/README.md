# agentrail-edge

The Agentrail edge, in front of a site on the Fetch API: Cloudflare Workers,
Vercel Routing Middleware, or anything else that speaks it. Each request is
answered through the site's origin and recorded as one event, sent to the
Agentrail collector after the answer through the platform's `waitUntil`. A local
HMAC operation signs the origin trace handoff before forwarding the request.

In an answer meant for agents (Markdown, `llms.txt`), every link to the
site's own hosts is marked, so the request an agent makes by following one
is joined to the page it came from. The marker comes off before the origin
sees the request, and only a real one: an `h` parameter or an `/h/` path
that does not read as a marker (an image's `h=600`) is the site's own, and
the request reaches the origin exactly as it was sent. A visitor's address,
and any verified principal, leave the edge only hashed with the workspace's
hash key.

Requests one edge answers share collector calls: an event goes at once when
no call is under way, and waits for the next one, with every other that
waited, when one is. A quiet site sends a call per request; a busy one
about one per round trip to the collector. A call that failed is tried
again after a random wait, so isolates that failed together do not retry
together, and never sooner than a `Retry-After` the collector sends. Every
call ends within 25 seconds of its request's answer, inside the 30 seconds
Cloudflare gives `waitUntil`; one that cannot is given up and told to
`onError`, never left for the platform to cancel unseen.

A visitor's session is a cookie the edge sets and the browser script reads
(`agentrail_session`). As in web analytics, it ends after 30 minutes
without a request, and a day after it began: every answer writes it again
for another 30 minutes.

```sh
npm install agentrail-edge
```

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Cloudflare Workers

The secret and the hash key come from Agentrail's setup page, as the
`AGENTRAIL_SECRET` and `AGENTRAIL_HASH_KEY` environment variables; the
collector's address is the one the setup page shows. Create the edge once,
on the first request, so the requests an isolate answers share calls; one
created per request still works, and sends a call per request.

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

## Vercel

In Routing Middleware, `vercel({ waitUntil, origin })` takes `waitUntil`
from `@vercel/functions` and fetches the site itself, since middleware cannot
rewrite an answer it passes on. Create the edge once, outside the handler.

## Backend trace handoff

Each forwarded request carries a new `traceparent` and an
`x-agentrail-trace-handoff` token authenticated with the workspace hash key.
The token binds the trace parent, key ID, issue time, HTTP method and final
origin path/query. The backend accepts it for 60 seconds. The caller's handoff,
tracestate and baggage are removed; the handoff response header is removed
before answering the visitor. A signing failure reaches `onError` as
`TraceHandoffSigningError` and the application request continues unsigned.

Apply path/query rewrites in `EdgeAdapter.prepareOriginRequest(request)`, or
`vercel({ waitUntil, prepareOriginRequest, origin })`. Signing happens after
that hook. The `origin` callback sends the prepared request; host-only changes
preserve the signature. A path/query change inside `origin` prevents backend
verification. `agentrail-node` starts a new trace for unsigned or refused
handoffs and keeps the caller's context as a directional span link.

## Options

- `hosts`: the site's own hosts, and how a link to each is marked: `'query'`
  adds the `h` parameter, `'path'` an `/h/<marker>` prefix, for a host whose
  calls an extra parameter would break.
- `queryAllowlist`: query parameters a recorded path keeps; every other is
  dropped, and named as dropped.
- `identify(request)`: the verified principal behind a request, by the site's
  own check of its method, URL and headers. It runs after the answer. A
  check that throws is told to `onError` as an `IdentifyError`, and the
  request is recorded without a principal.
- `ignoreRequest(request)`: requests passed to the origin untouched and
  recorded nowhere. See [Your own servers](#your-own-servers).
- `sessionIdleTimeout`: seconds without a request after which a session
  ends; 1800 (30 minutes) by default.
- `sessionCookieDomain`: the domain a session is shared across, as
  `example.com` for `docs.example.com` and `app.example.com`; by default,
  the one host. Give the browser script the same two values.
- `sessionCookie`, `service`, `fetch`: the session cookie's name, the
  service the events name, and the fetch the collector's calls go through.
- `signers`: registrable hosts, beside the known signers, whose Web Bot
  Auth key directories the edge may read; a signature by any other host is
  recorded as a claim it did not check, and that host is never contacted.
- `onError(error)`: told of events that could not be sent, and of an
  `identify` that threw; they are logged otherwise. Neither ever reaches the
  visitor.

## Your own servers

Calls your own servers make through this edge are not visitors or agents. A
page rendered on the server that reads your API would otherwise record a step
for every read, all from a few addresses at a steady rate, and those steps
crowd out the journeys you want to see.

Leave them out with something only your servers can send:

```ts
const edge = createEdge({
  // ...
  ignoreRequest: (request) =>
    request.headers.get('x-my-internal') === env.INTERNAL_SECRET,
});
```

A user agent or an address will not do: any caller can claim one, and a caller
who matched it would never be recorded. Compare a secret in constant time
where your platform offers it.

## What it records of the caller

Beside the user agent, each event carries what the caller and the network
said of it, for the collector to read as features (never as proofs) when it
asks who the caller is: the `Accept` sent, and the `Sec-Fetch-Site`, `-Mode`
and `-Dest` a browser sends and a programmatic fetcher does not; what the
platform says of the client, where it says anything (`cloudflare(ctx)` reads
`request.cf`: the autonomous system and country on every plan, the JA4
fingerprint and the verified-bot category where the zone has Bot Management;
`vercel()` reads `x-vercel-ip-country` and `x-vercel-ja4-digest`, and BotID's
verified bots stay in the app, where `checkBotId()` runs; an adapter of your
own gives `signals(request)` or nothing); and a Web Bot Auth signature,
checked against the keys the agent publishes. The check reads the agent's
key directory from the edge, once per its `max-age`, from the known signers'
hosts and those `signers` names and from no other, so a site's edge contacts
only hosts it has been told of; a directory that cannot be read leaves the
signature `directory_unreachable`, never `invalid`.
Nothing here is hashed, since nothing identifies a person: a fingerprint is
shared by every copy of one client.

## Licence

[Apache-2.0](LICENSE).
