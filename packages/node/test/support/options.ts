export const HASH_KEY = 'synthetic-workspace-key-for-node-tests';
export function options(endpoint: string) {
  return {
    collector: { endpoint, secret: 'ajs_synthetic_node_source' },
    hashKey: HASH_KEY,
    serviceName: 'synthetic-api',
    queue: {
      maxRecords: 32,
      batchSize: 8,
      scheduledDelayMs: 60_000,
      exportTimeoutMs: 500,
      flushTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
    },
  };
}
