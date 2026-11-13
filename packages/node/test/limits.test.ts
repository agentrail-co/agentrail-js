import { OTLP } from 'agentrail-contract';
import { describe, expect, it } from 'vitest';

import { EXPORT_BATCH_BYTES, MCP_PAYLOAD_BYTES } from '../src/limits.js';

describe('the limits the collector sets', () => {
  // Fails if someone changes a limit here and not in the contract (or takes
  // a new contract without following it): spans would be cut, or batched,
  // differently from the Go and Python SDKs and from what the collector takes.
  it('are the contract’s', () => {
    expect({
      mcpPayloadBytes: MCP_PAYLOAD_BYTES,
      exportBatchBytes: EXPORT_BATCH_BYTES,
    }).toEqual({
      mcpPayloadBytes: OTLP.limits.mcpPayloadBytes,
      exportBatchBytes: OTLP.limits.exportBatchBytes,
    });
  });
});
