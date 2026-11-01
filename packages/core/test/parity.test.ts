import { createHash, createHmac } from 'node:crypto';

import {
  MARKERS,
  SURFACES as COLLECTOR_SURFACES,
  bytesOf,
} from 'agentrail-contract';
import { describe, expect, it } from 'vitest';

import {
  MAX_LINK_INDEX,
  SURFACES,
  hashKeyIdOf,
  keyedHash,
  linkMarker,
  mintMarker,
  parseMarker,
} from '../src/index.js';

/**
 * This package keeps the engine's shapes and arithmetic without importing
 * the engine, which is private to Argus: these prove the two have not drifted
 * apart, against the contract Argus writes (agentrail-contract).
 */

describe('agentrail core and the collector', () => {
  // Fails if a surface is added or dropped here only: the collector would
  // refuse every call that names it.
  it('name the same surfaces', () => {
    expect([...SURFACES]).toEqual([...COLLECTOR_SURFACES]);
  });

  // Fails if the alphabet, the check or the lane encoding changes here only:
  // the engine would refuse every marker an edge planted, and markers would
  // prove nothing.
  it('mint and link the markers the engine mints and links', () => {
    expect(MAX_LINK_INDEX).toBe(MARKERS.maxLinkIndex);
    for (const { random, marker } of MARKERS.minted)
      expect(mintMarker(bytesOf(random))).toBe(marker);
    for (const { marker, lane, linked } of MARKERS.linked)
      expect(linkMarker(marker, lane)).toBe(linked);
  });

  // Fails if the reading drifts from the engine's, as dropping the check
  // character or the case folding would: the edge would take a site's own
  // `h=600` off a request as a marker, or leave a real one on.
  it('read a value as the engine reads it', () => {
    for (const { raw, result } of MARKERS.parsed)
      expect(parseMarker(raw), raw).toEqual(result);
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
  // the id out of the key it holds: every workspace's stored events would be
  // on another key than its new ones, and nothing hashed before would ever
  // be compared again.
  it('names a hash key as Argus does: the first 16 hex characters of its SHA-256', async () => {
    for (const key of ['a'.repeat(64), crypto.randomUUID().repeat(2)])
      expect(await hashKeyIdOf(key)).toBe(
        createHash('sha256').update(key).digest('hex').slice(0, 16),
      );
  });
});
