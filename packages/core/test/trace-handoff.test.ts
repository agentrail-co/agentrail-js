import { describe, expect, it } from 'vitest';

import { hashKeyIdOf } from '../src/hash.js';
import {
  signTraceHandoff,
  traceHandoffTarget,
  verifyTraceHandoff,
} from '../src/trace-handoff.js';

import { TRACE_HANDOFF } from 'agentrail-contract';
const HANDOFF_VECTOR = TRACE_HANDOFF.fixtures[0];
if (HANDOFF_VECTOR === undefined)
  throw new Error('The receiver contract has no handoff vector.');

const KEY = HANDOFF_VECTOR.hashKey;
const TRACEPARENT = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
const NOW = 1_793_743_200_000;

describe('authenticated trace handoff', () => {
  // Fails if the MAC does not bind every request/context field, or expiry is skipped.
  it('verifies the same forwarded request and refuses context, target, key and time tampering', async () => {
    const hashKeyId = await hashKeyIdOf(KEY);
    const input = {
      traceparent: TRACEPARENT,
      hashKeyId,
      issuedAt: NOW,
      method: 'POST',
      target: '/api/mcp?x=1+2&x=%20',
    };
    const token = await signTraceHandoff(input, KEY);
    await expect(
      signTraceHandoff({ ...input, traceparent: ` ${input.traceparent}` }, KEY),
    ).rejects.toThrow();
    expect(token).toBe(HANDOFF_VECTOR.token);
    const expected = {
      hashKey: KEY,
      traceparent: input.traceparent,
      method: input.method,
      target: input.target,
      now: NOW + 1,
    };
    expect(await verifyTraceHandoff(token, expected)).toMatchObject({
      kind: 'verified',
      context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16) },
    });
    for (const [changed, reason] of [
      [{ traceparent: TRACEPARENT.replace('-01', '-00') }, 'context_mismatch'],
      [{ method: 'GET' }, 'signature_invalid'],
      [{ target: '/api/mcp?x=1%202&x=%20' }, 'signature_invalid'],
      [{ hashKey: `${KEY}-rotated` }, 'key_mismatch'],
      [{ now: NOW + 60_001 }, 'expired'],
      [{ now: NOW - 1 }, 'future'],
    ] as const)
      expect(
        await verifyTraceHandoff(token, { ...expected, ...changed }),
      ).toEqual({ kind: 'refused', reason });
    expect(
      await verifyTraceHandoff(
        token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'),
        expected,
      ),
    ).toEqual({ kind: 'refused', reason: 'signature_invalid' });
    expect(await verifyTraceHandoff(null, expected)).toEqual({
      kind: 'refused',
      reason: 'missing',
    });
    expect(
      await verifyTraceHandoff('caller-controlled-header', expected),
    ).toEqual({ kind: 'refused', reason: 'malformed' });
    expect(await verifyTraceHandoff(token + '.extra', expected)).toEqual({
      kind: 'refused',
      reason: 'malformed',
    });
    expect(
      await verifyTraceHandoff(token, { ...expected, now: NOW + 60_000 }),
    ).toMatchObject({ kind: 'verified' });
  });

  // Fails if signing normalizes an encoded path/query differently from the wire target.
  it('preserves forwarded target encoding and excludes URL fragments', () => {
    expect(
      traceHandoffTarget('https://origin.test/base/%2f?q=1+2&q=%20#not-sent'),
    ).toBe('/base/%2f?q=1+2&q=%20');
    expect(traceHandoffTarget('https://origin.test/path?')).toBe('/path?');
  });
});
