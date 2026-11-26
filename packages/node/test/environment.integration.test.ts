import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { attributesOf, collector } from './support/collector.js';
import { options } from './support/options.js';
import { createTestSdk } from './support/sdk.js';

// The application's own OpenTelemetry settings, in this test file's own
// process: a vendor's key, compression, a certificate and a value limit.
const certificate = fileURLToPath(import.meta.url);
Object.assign(process.env, {
  OTEL_EXPORTER_OTLP_HEADERS: 'x-vendor-team=synthetic-shared-key',
  OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-vendor-traces=synthetic-traces-key',
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-vendor-logs=synthetic-logs-key',
  OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
  OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '12',
  OTEL_EXPORTER_OTLP_CERTIFICATE: certificate,
});

class SyntheticBusinessFailure extends Error {
  override name = 'SyntheticBusinessFailure';
}

// Fails if the SDK's exporters take anything from the application's OTEL_*
// environment: a vendor's key in OTEL_EXPORTER_OTLP_HEADERS would be sent
// to Agentrail, compression or a certificate would change how the SDK
// reaches its collector, and a value limit would cut what it sends.
it("takes nothing from the application's OpenTelemetry environment", async () => {
  const reads = vi.spyOn(fs, 'readFileSync');
  const sink = await collector();
  const sdk = createTestSdk(options(sink.endpoint));
  try {
    await expect(
      sdk.client.milestone(
        'checkout',
        { surface: 'custom', kind: 'checkout' },
        () => {
          throw new SyntheticBusinessFailure();
        },
      ),
    ).rejects.toBeInstanceOf(SyntheticBusinessFailure);
    sdk.client.log({ severityNumber: 9 });
    await sdk.client.flush();
    expect(sink.packets.map((packet) => packet.path).sort()).toEqual([
      '/ingest/otlp/v1/logs',
      '/ingest/otlp/v1/traces',
    ]);
    for (const { headers } of sink.packets) {
      expect(
        Object.keys(headers).filter((name) => name.startsWith('x-')),
      ).toEqual([]);
      expect(headers['content-encoding']).toBeUndefined();
      expect(headers.authorization).toBe('Bearer ajs_synthetic_node_source');
    }
    // Decodes as plain protobuf, its values whole.
    expect(attributesOf(sink.spans()[0]?.attributes)['error.type']).toBe(
      'SyntheticBusinessFailure',
    );
    expect(sink.logs()).toHaveLength(1);
    expect(
      reads.mock.calls.filter(([path]) => String(path) === certificate),
    ).toEqual([]);
  } finally {
    reads.mockRestore();
    await sdk.client.shutdown();
    await sink.close();
  }
});
