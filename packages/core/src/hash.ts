/**
 * The keyed hash a component applies before anything leaves the customer: a
 * client address, a verified principal's id. HMAC-SHA256 with the
 * workspace's hash key, cut to 32 hex characters, so every component of one
 * workspace hashes one value alike and the engine can only ever compare two
 * for equality (docs/research/agent-journey-correlation.md, 12.12).
 */

const encoder = new TextEncoder();

/** HMAC keys imported once per hash key, for the life of the runtime. */
const keys = new Map<string, Promise<CryptoKey>>();

function keyOf(hashKey: string): Promise<CryptoKey> {
  const known = keys.get(hashKey);
  if (known !== undefined) return known;
  const imported = crypto.subtle.importKey(
    'raw',
    encoder.encode(hashKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keys.set(hashKey, imported);
  return imported;
}

export async function keyedHash(
  hashKey: string,
  value: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await keyOf(hashKey),
    encoder.encode(value),
  );
  return [...new Uint8Array(signature)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
