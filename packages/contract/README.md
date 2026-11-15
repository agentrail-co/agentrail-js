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
  (`mcpAttributes`, described in `mcpSpans`), the two recorded MCP requests
  and the request facts an SDK sends for each (`mcpRequestFacts`), the header
  names no caller writes (`headerNames`), bounds and synthetic
  accepted/refused exports for traces and logs;
- `traceHandoff`: header, age bound and independently calculated signing vectors.

The engine is private to Argus, so these packages' tests check what they
build against this file instead (`src/index.ts`). This package is never
published.

## Where it comes from

Argus writes it (`apps/api/sdk-contract.json`, kept current by
`apps/api/test/sdk-contract.test.ts`). It is copied here byte for byte and
never edited here.

Copied from Argus commit `9625ffe6e2b60cd539a8fbd18445273d437c93fd`,
including the request facts an MCP span carries and the header names no
caller writes (sha256
`20adfff8a062274d104e9251e36834c3ef1b92821b03fc0a5d44ad86070afcba`).

To take a newer one: copy argus's `apps/api/sdk-contract.json` over this
file, change the commit above, and run `pnpm test`. A test that fails then
is a change these packages must follow.
