import { expect, it } from 'vitest';
import { attributesOf, collector } from './support/collector.js';
import { options } from './support/options.js';
import { createTestSdk } from './support/sdk.js';

// Fails if a milestone's callback error is wrapped, replaced or swallowed,
// or its step stops saying it failed.
it("rethrows the application's own error and records the step as failed", async () => {
  const sink = await collector();
  const errors: Error[] = [];
  const sdk = createTestSdk({
    ...options(sink.endpoint),
    onError: (error) => {
      errors.push(error);
    },
  });
  try {
    const businessError = new RangeError('synthetic business failure');
    await expect(
      sdk.client.milestone(
        'checkout',
        { surface: 'custom', kind: 'checkout' },
        () => {
          throw businessError;
        },
      ),
    ).rejects.toBe(businessError);
    await sdk.client.flush();
    const [step] = sink.spans();
    expect(step?.status?.code).toBe(2);
    expect(attributesOf(step?.attributes)['error.type']).toBe('RangeError');
    expect(errors).toEqual([]);
  } finally {
    await sdk.client.shutdown();
    await sink.close();
  }
});
