/**
 * What one OTLP export can carry: the collector's body limit
 * (`otlp.limits.bodyBytes` in the contract).
 */
export const EXPORT_BODY_BYTES = 16 * 1024 * 1024;
/**
 * A span batch closes before its estimated size passes this: the rest is
 * headroom for the resource, the envelope and the estimate's error.
 */
export const BATCH_BYTES = EXPORT_BODY_BYTES - 1024 * 1024;
/**
 * The most MCP payload text one span carries, both payloads together, so the
 * span alone fits one batch: its other attributes are bounded far below the
 * headroom left.
 */
export const RECORD_PAYLOAD_BYTES = BATCH_BYTES - 1024 * 1024;
/** The most MCP payload text one span queue holds, in flight included. */
export const QUEUE_PAYLOAD_BYTES = 64 * 1024 * 1024;
