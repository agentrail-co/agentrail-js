# Agentrail edge

The edge adapter in front of a customer's site, on the Fetch API:
`createEdge(options).handle(request, cloudflare(ctx))` in a Worker, or
`vercel({ waitUntil, origin })` in Vercel Routing Middleware. One event per
request goes to the collector after the answer, through the platform's
`waitUntil`. What it records and why:
[docs/features/journey-linkage/overview.md](../../docs/features/journey-linkage/overview.md)
("The edge adapter").

## Rules no machine can check

- A public endpoint never takes its parent from outside: the edge starts a
  trace of its own for every request and keeps a caller's `traceparent` as a
  span link only.
- Markers go in after the cache: a marked answer is `private, no-store`, and
  the markers come off before the origin sees a request.
- A recorded path keeps only the allowlisted query; the rest is dropped and
  named in `redactions`.
- The edge never breaks the site: an answer that is not agent-facing passes
  as it came, and a failure to send events is told to `onError`, never to the
  visitor.

Tests: `pnpm --filter @agentrail/edge test:unit`. They read every event as
the collector does, with the engine's own schema, and link a page and the
request that follows it with the engine.
