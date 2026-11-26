import type { NodeOptions } from '../../src/options.js';
import { createSdk } from '../../src/sdk.js';

/**
 * A client on the SDK's own tracer without `init`'s HTTP capture, for a
 * test of what the client records on its own (milestones, logs, MCP calls,
 * delivery). Internal: the package exports `init` only, and tests made this
 * way register nothing process-wide, so a file may make many.
 */
export function createTestSdk(options: NodeOptions) {
  return createSdk(options);
}
