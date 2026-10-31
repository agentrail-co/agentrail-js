/**
 * Ids for what a component mints (an event, a tab, a batch of frames): a
 * random UUID, version 4, from `crypto.getRandomValues`. `crypto.randomUUID`
 * mints the same, but a page has it only over HTTPS: on a site served over
 * plain HTTP, the browser script would record nothing.
 */

/** Bytes as lowercase hex, two characters each. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/** A random UUID, version 4. */
export function newId(): string {
  const hex = hexOf(crypto.getRandomValues(new Uint8Array(16)));
  // The version is 4; the variant's two bits are 10, the two after random.
  const variant = (8 | (Number.parseInt(hex.charAt(16), 16) & 3)).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
