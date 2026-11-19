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
- `cliHeader`: the `x-agentrail-cli` header a CLI sends its own API (its
  members, how it is read, how a CLI derives its session) and vectors every
  writer and reader checks; `otlp.cliAttributes` and `otlp.cliSpans` are what
  a server SDK sends for it.

The engine is private to Argus, so these packages' tests check what they
build against this file instead (`src/index.ts`). This package is never
published.

## Where it comes from

Argus writes it (`apps/api/sdk-contract.json`, kept current by
`apps/api/test/sdk-contract.test.ts`). It is copied here byte for byte and
never edited here.

Copied from Argus commit `b9f706771`, branch `fix/linkage-wire-behind-edge`
(argus#762), including the request facts an MCP span carries, the header
names no caller writes (now with the names Render's proxy and an Agentrail
edge add on the way), and the CLI header with the event's `cli` (sha256
`49fa11fd358a233f138adb73273fccf86997eda3bd037c8b877671c62d1f4cc4`).

To take a newer one: copy argus's `apps/api/sdk-contract.json` over this
file, change the commit above, and run `pnpm test`. A test that fails then
is a change these packages must follow.
