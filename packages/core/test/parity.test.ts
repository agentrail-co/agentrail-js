import { createHash, createHmac } from 'node:crypto';

import {
  MAX_LINK_INDEX as ENGINE_MAX_LINK_INDEX,
  SURFACES as ENGINE_SURFACES,
  linkMarker as engineLinkMarker,
  mintMarker as engineMintMarker,
  parseMarker,
  type IngestEvent,
} from '@argus/journey-linkage';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  MAX_LINK_INDEX,
  SURFACES,
  hashKeyIdOf,
  keyedHash,
  linkMarker,
  mintMarker,
  type AgentrailEvent,
} from '../src/index.js';

/**
 * This package keeps the engine's shapes and arithmetic without importing
 * the engine; these prove the two have not drifted apart.
 */

function bytes(seed: number): Uint8Array {
  return Uint8Array.from(
    { length: 8 },
    (_, index) => (seed * 37 + index * 101) % 256,
  );
}

describe('agentrail core and the engine', () => {
  // Fails to typecheck if a field of the event the collector takes, or its
  // type, changes on one side only; fails if a surface is added on one side.
  it('describe one event, over the same surfaces', () => {
    expectTypeOf<AgentrailEvent>().toExtend<IngestEvent>();
    expectTypeOf<IngestEvent>().toExtend<AgentrailEvent>();
    expect([...SURFACES]).toEqual([...ENGINE_SURFACES]);
  });

  // Fails if the alphabet, the check or the lane encoding changes here only:
  // the engine would refuse every marker an edge planted, and markers would
  // prove nothing.
  it('mint the markers the engine mints, and the engine reads every lane back', () => {
    expect(MAX_LINK_INDEX).toBe(ENGINE_MAX_LINK_INDEX);
    for (const seed of [0, 1, 7, 99, 255]) {
      const marker = mintMarker(bytes(seed));
      expect(marker).toBe(engineMintMarker(bytes(seed)));
      for (const lane of [0, 1, 31, 32, MAX_LINK_INDEX]) {
        const linked = linkMarker(marker, lane);
        expect(linked).toBe(engineLinkMarker(marker, lane));
        expect(parseMarker(linked)).toEqual({
          valid: true,
          base: marker.slice(0, 13),
          link: lane,
        });
      }
    }
  });

  // Fails if the hash changes algorithm or length: an edge and a backend of
  // one workspace, or this edge and the lab's recorded traffic, would hash
  // one address two ways and the engine could never see they are equal.
  it('hash as every component of a workspace does: HMAC-SHA256, 32 hex characters', async () => {
    const key = 'a'.repeat(64);
    for (const value of ['203.0.113.7', '2001:db8::1', 'user-1']) {
      expect(await keyedHash(key, value)).toBe(
        createHmac('sha256', key).update(value).digest('hex').slice(0, 32),
      );
    }
  });

  // Fails if a component names its key differently from Argus, which works
  // the id out of the key it holds (the 202610291400 migration, in SQL):
  // every workspace's stored events would be on another key than its new
  // ones, and nothing hashed before would ever be compared again.
  it('names a hash key as Argus does: the first 16 hex characters of its SHA-256', async () => {
    for (const key of ['a'.repeat(64), crypto.randomUUID().repeat(2)])
      expect(await hashKeyIdOf(key)).toBe(
        createHash('sha256').update(key).digest('hex').slice(0, 16),
      );
  });
});
