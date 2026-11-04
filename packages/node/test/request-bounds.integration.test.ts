import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { init, createProcessors, ConfigurationError } from '../src/index.js';
import { collector, attributesOf } from './support/collector.js';
import { options } from './support/options.js';

// Fails if oversized optional URL evidence can exceed the receiver's 4096-character contract and poison adjacent spans.
it('keeps entries but omits oversized URLs before batching unrelated requests', async () => {
  const sink = await collector();
  const failures: Error[] = [];
  const sdk = await init({
    ...options(sink.endpoint),
    onError: (error) => {
      failures.push(error);
    },
  });
  const server = createServer((_request, response) => {
    response.end('application unchanged');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture address.');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of [`/${'a'.repeat(5000)}`, '/ordinary?h=']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('application unchanged');
    }
    await sdk.flush();
    expect(sink.spans()).toHaveLength(2);
    expect(
      attributesOf(sink.spans()[0]?.attributes)['url.full'],
    ).toBeUndefined();
    expect(attributesOf(sink.spans()[1]?.attributes)['url.full']).toBe(
      origin + '/ordinary',
    );
    expect(sdk.diagnostics().spans).toEqual({
      accepted: 2,
      exported: 2,
      dropped: 0,
      pending: 0,
    });
    expect(failures).toEqual([]);
  } finally {
    await sdk.shutdown();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await sink.close();
  }
});

// Fails if an oversized configured resource poisons every otherwise-valid export.
it.each(['serviceName', 'serviceInstanceId'] as const)(
  'rejects oversized %s at construction',
  (field) => {
    expect(() =>
      createProcessors({
        ...options('http://127.0.0.1:1/ingest/otlp'),
        [field]: 'a'.repeat(4097),
      }),
    ).toThrow(ConfigurationError);
  },
);
