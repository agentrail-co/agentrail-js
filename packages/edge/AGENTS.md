# Agentrail edge

The edge adapter in front of a customer's site, on the Fetch API:
`createEdge(options).handle(request, cloudflare(ctx))` in a Worker, or
`vercel({ waitUntil, origin })` in Vercel Routing Middleware. One event per
request goes to the collector after the answer, through the platform's
`waitUntil`, in calls the requests one edge answers share. How to run it:
[README.md](README.md).

## Rules no machine can check

- A public endpoint never takes its parent from outside: the edge starts a
  trace of its own for every request and keeps a caller's `traceparent` as a
  span link only.
- Markers go in after the cache: a marked answer is `private, no-store`, and
  the markers come off before the origin sees a request. Only what reads as
  a marker (`parseMarker`) comes off; the rest of the request reaches the
  origin as it was sent, its query never written anew.
- A recorded path, and a redirect's recorded target, keep only the
  allowlisted query; the rest is dropped and named in `redactions`.
- The edge never breaks the site: an answer that is not agent-facing passes
  as it came, and a failure to send events is told to `onError`, never to the
  visitor.
- A call goes from a request still waiting on it, and ends within 25 s of
  that request's answer: Cloudflare cancels what a request left running once
  its `waitUntil` has ended, or 30 s after the answer, and no one is told.
  The local check is `wrangler dev`; no unit test can see a cancellation.

Tests: `pnpm --filter agentrail-edge test`. Every call they send is checked
against what the collector takes (`packages/contract`).
