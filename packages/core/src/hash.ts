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

/** The first `bytes` bytes of a digest, as lowercase hex. */
function hexOf(digest: ArrayBuffer, bytes: number): string {
  return [...new Uint8Array(digest)]
    .slice(0, bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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
  return hexOf(signature, 16);
}

/**
 * The id a component's calls name its hash key by: the first 16 hex
 * characters of the key's SHA-256. The collector stamps it on each event
 * carrying a hashed value, and the linker compares hashed values only
 * between events hashed with one key, so a workspace can replace its key.
 * Argus works out the same id from the key it holds, so a key needs no id
 * of its own; 64 bits of its hash say nothing of the key.
 */
export async function hashKeyIdOf(hashKey: string): Promise<string> {
  return hexOf(
    await crypto.subtle.digest('SHA-256', encoder.encode(hashKey)),
    8,
  );
}
