/**
 * Planted markers: 64 random bits in Crockford base32 (13 characters) and a
 * Luhn mod 32 check character; a link's marker adds a two-character lane
 * before the check, so each link of a response is proven on its own. The
 * engine reads them back case-folded, with Crockford's look-alikes, and
 * refuses any whose check fails (docs/research/agent-journey-correlation.md,
 * 5.2 and 15.1). This is the same arithmetic and the same reading as the
 * engine's; `test/parity.test.ts` proves the two agree.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BASE = ALPHABET.length;
const PAYLOAD_LENGTH = 13;
const LANE_LENGTH = 2;
const RANDOM_BYTES = 8;

/** The last lane a response's links can take; past it a link goes unmarked. */
export const MAX_LINK_INDEX = BASE * BASE - 1;

/** A marker that is not one this package minted, or a lane out of range. */
export class MarkerError extends Error {
  override readonly name = 'MarkerError';
}

function valueOf(character: string): number {
  const value = ALPHABET.indexOf(character);
  if (value === -1)
    throw new MarkerError(`Not in the marker alphabet: ${character}.`);
  return value;
}

function checkValue(values: readonly number[]): number {
  let sum = 0;
  let factor = 2;
  // From the last character back, doubling every other one.
  for (const value of [...values].reverse()) {
    const addend = factor * value;
    sum += Math.floor(addend / BASE) + (addend % BASE);
    factor = factor === 2 ? 1 : 2;
  }
  return (BASE - (sum % BASE)) % BASE;
}

function withCheck(values: readonly number[]): string {
  return [...values, checkValue(values)]
    .map((value) => ALPHABET.charAt(value))
    .join('');
}

/** A response marker from eight random bytes. */
export function mintMarker(random: Uint8Array): string {
  if (random.length !== RANDOM_BYTES)
    throw new MarkerError(
      `A marker needs ${String(RANDOM_BYTES)} random bytes, not ${String(random.length)}.`,
    );
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  const values: number[] = [];
  for (let index = PAYLOAD_LENGTH - 1; index >= 0; index -= 1)
    values.push(Number((bits >> BigInt(index * 5)) & 31n));
  return withCheck(values);
}

/** A response marker from this runtime's strong random source. */
export function newMarker(): string {
  return mintMarker(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
}

/** How the engine reads a value: a marker, or why it is none. */
export type ParsedMarker =
  | {
      readonly valid: true;
      /** The response marker, canonical, without its check character. */
      readonly base: string;
      /** The lane of a link's marker; null for a response's own. */
      readonly link: number | null;
    }
  | {
      readonly valid: false;
      readonly reason: 'length' | 'alphabet' | 'check';
    };

/**
 * Reads a value as an agent sent it back, as the engine does: case-folded,
 * `-` dropped, I and L read as 1 and O as 0; then 14 or 16 characters of the
 * alphabet whose check character holds. Only a value it reads as valid is a
 * marker: anything else, an image's `h=600` or a path's `/h/getting-started`,
 * is the site's own.
 */
export function parseMarker(raw: string): ParsedMarker {
  const text = raw
    .toUpperCase()
    .replaceAll('-', '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0');
  if (
    text.length !== PAYLOAD_LENGTH + 1 &&
    text.length !== PAYLOAD_LENGTH + LANE_LENGTH + 1
  )
    return { valid: false, reason: 'length' };
  const values: number[] = [];
  for (const character of text) {
    const value = ALPHABET.indexOf(character);
    if (value === -1) return { valid: false, reason: 'alphabet' };
    values.push(value);
  }
  const check = values.pop();
  if (check !== checkValue(values)) return { valid: false, reason: 'check' };
  const [high, low] = values.slice(PAYLOAD_LENGTH);
  return {
    valid: true,
    base: text.slice(0, PAYLOAD_LENGTH),
    link: high === undefined || low === undefined ? null : high * BASE + low,
  };
}

/** The marker for one link of a response: its lane. */
export function linkMarker(marker: string, index: number): string {
  if (marker.length !== PAYLOAD_LENGTH + 1)
    throw new MarkerError(`Not a response marker: ${marker}.`);
  if (!Number.isInteger(index) || index < 0 || index > MAX_LINK_INDEX)
    throw new MarkerError(
      `A lane is 0 to ${String(MAX_LINK_INDEX)}, not ${String(index)}.`,
    );
  const values = Array.from(marker.slice(0, PAYLOAD_LENGTH), valueOf);
  values.push(Math.floor(index / BASE), index % BASE);
  return withCheck(values);
}
