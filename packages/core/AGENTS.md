# Agentrail core

What every Agentrail component shares: the event the collector takes
(`POST /ingest/events`), markers, the keyed hash, W3C trace context, the
session the edge and the browser script share, the `x-agentrail-cli` header
a CLI sends its own API, and the client that batches
events to the collector and retries what failed. It runs
wherever the Fetch API and WebCrypto do: Cloudflare Workers, Vercel's edge,
Node, browsers. What it offers: [README.md](README.md).

## Rules no machine can check

- The event, the marker arithmetic and reading, and the hash are the
  engine's, kept here without importing it: the engine is private to Argus, and this ships
  to customers. `test/parity.test.ts` proves they agree with the contract
  Argus writes (`packages/contract`). A change to any of them starts in
  Argus.
- An address or a principal's id leaves a component only as `keyedHash` with
  the workspace's hash key. Never send one as it is, and never put the hash
  key in a page.
- The CLI header is read by server SDKs long after the CLIs that wrote it
  were built: a version only adds members, and never changes what one
  means, so `readCliHeader` takes any version from 1 and ignores members it
  does not know. Its value is fixed by `test/cli-header.test.ts`, which the
  Go and Python CLI SDKs match.
- A component never mints `tenant`, `observedAt` or `hashKeyId`: the
  collector stamps them. A component that hashes names its key in every call
  (`component.hashKeyId`, from `hashKeyIdOf`).

Lint stops a `node:` import in `src/`. Tests:
`pnpm --filter agentrail-core test`.
