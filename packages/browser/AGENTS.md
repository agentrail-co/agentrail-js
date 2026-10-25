# Agentrail browser

The script on a customer's pages, on the DOM and the Fetch API:
`start({ key, collector })`, once a page, as early as it can load. It sends
page views, the trace on first-party calls and WebMCP tool calls to the
collector (`POST /ingest/browser`) with the browser source's public key, and,
loaded apart, raw behaviour and the tab's fingerprint. What it records and
why: [docs/features/journey-linkage/overview.md](../../docs/features/journey-linkage/overview.md)
("The browser script").

## Rules no machine can check

- Never captured: which key was pressed, what was typed, pasted or chosen,
  the DOM or a selector, the clipboard, a query parameter outside the
  allowlist. A key is a press number and a class; an element is a number on
  its tab.
- Frames are raw, timing only. A feature is computed in the collector, never
  here: a new paper is a new derivation over frames already kept.
- The hash key never goes into a page, and the page has no address to hash:
  a browser event's `actor.egress` is null.
- The fingerprint is read by this package's own code under FingerprintJS's
  component names; FingerprintJS itself is never a dependency (its licence
  forbids production use).
- Behaviour and the fingerprint each switch off; the proofs need no consent.

Tests: `pnpm --filter @agentrail/browser test:unit`, on jsdom. They read
every event as the collector does, with the engine's own schema, and link a
page and its calls with the engine.
