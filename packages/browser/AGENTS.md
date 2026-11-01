# Agentrail browser

The script on a customer's pages, on the DOM and the Fetch API:
`start({ key, collector })`, once a page, as early as it can load, or the
tag a site pastes, which loads `dist/agentrail.js` (`src/script.ts` and
`src/tag.ts`, bundled as one classic file by `scripts/bundle.mts`; the API
serves it). It sends
page views, the trace on first-party calls and WebMCP tool calls to the
collector (`POST /ingest/browser`) with the browser source's public key, and,
loaded apart, raw behaviour and the tab's fingerprint. How to install it:
[README.md](README.md).

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
  component names, and FingerprintJS itself is never a dependency: what
  this package measures is its own, and the script stays one small file.
- Behaviour and the fingerprint each switch off; the proofs need no consent.

Tests: `pnpm --filter agentrail-browser test`, on jsdom. Every call they
send is checked against what the collector takes (`packages/contract`).
