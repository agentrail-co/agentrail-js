/**
 * The collector's limits (`otlp.limits` in the contract); the contract
 * package is never published, so they are kept here and
 * `test/limits.test.ts` holds them to it.
 */
/**
 * A span batch closes before its estimated size passes this
 * (`otlp.limits.exportBatchBytes`): the rest is headroom for the resource,
 * the envelope and the estimate's error, under the 16 MiB a body may hold.
 */
export const EXPORT_BATCH_BYTES = 15 * 1024 * 1024;
/**
 * The most MCP payload text one span carries, both payloads together, so the
 * span alone fits one batch (`otlp.limits.mcpPayloadBytes`).
 */
export const MCP_PAYLOAD_BYTES = 14 * 1024 * 1024;
/** The most MCP payload text one span queue holds, in flight included. */
export const QUEUE_PAYLOAD_BYTES = 64 * 1024 * 1024;
