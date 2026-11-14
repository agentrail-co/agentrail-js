# The collector's contract

`sdk-contract.json` is what the Argus collector takes and how its engine
reads a marker:

- `ingestRequest`: the body of `POST /ingest/events`, as JSON Schema;
- `browserCall`: the body of `POST /ingest/browser`, as JSON Schema;
- `browserPayloadCall`: the body of `POST /ingest/browser/payloads?key=`, one
  WebMCP tool run with the content its page captured, as JSON Schema (the
  key is in the query, never the body);
- `markers`: markers the engine minted from fixed bytes, linked on fixed
  lanes, and read back from valid and broken input;
- `notes`: what the collector also refuses that a schema cannot say.
- `otlp`: upstream message references, enrichment and MCP attributes
  (`mcpAttributes`, described in `mcpSpans`), bounds and synthetic
  accepted/refused exports for traces and logs;
- `traceHandoff`: header, age bound and independently calculated signing vectors.

The engine is private to Argus, so these packages' tests check what they
build against this file instead (`src/index.ts`). This package is never
published.

## Where it comes from

Argus writes it (`apps/api/sdk-contract.json`, kept current by
`apps/api/test/sdk-contract.test.ts`). It is copied here byte for byte and
never edited here.

Copied from Argus commit `78f9621d4673eab0f3e454575b98903352ee02f6`,
including a thrown tool as a failed call and the browser payload call's key
in its query (sha256
`a25284880b58df53e19d2c2854cbe1bc66defb6349f7c9b96009c975ac628a19`).

To take a newer one: copy argus's `apps/api/sdk-contract.json` over this
file, change the commit above, and run `pnpm test`. A test that fails then
is a change these packages must follow.
