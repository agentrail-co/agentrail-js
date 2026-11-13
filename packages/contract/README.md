# The collector's contract

`sdk-contract.json` is what the Argus collector takes and how its engine
reads a marker:

- `ingestRequest`: the body of `POST /ingest/events`, as JSON Schema;
- `browserCall`: the body of `POST /ingest/browser`, as JSON Schema;
- `browserPayloadCall`: the body of `POST /ingest/browser/payloads`, one
  WebMCP tool run with the content its page captured, as JSON Schema;
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

Copied from argus branch `feat/mcp-analytics`, base commit
`23eaa10c2e85a5b86648468bc5e28e304394c19e`, where it was not yet committed
at copy time (sha256
`b0466ae7915307279d0c8655a2c6931c1320fecadae169d2135a4655d763038e`).

To take a newer one: copy argus's `apps/api/sdk-contract.json` over this
file, change the commit above, and run `pnpm test`. A test that fails then
is a change these packages must follow.
