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

Copied from Argus commit `ddb046d7fb5a884724e0f62fdf4441c64dee452c`,
including standard MCP naming attributes and `tool_error` (sha256
`6a0b1e13d364da92831ba495b30a42ae0c1da7119c771e4b4a11a2e93743f498`).

To take a newer one: copy argus's `apps/api/sdk-contract.json` over this
file, change the commit above, and run `pnpm test`. A test that fails then
is a change these packages must follow.
