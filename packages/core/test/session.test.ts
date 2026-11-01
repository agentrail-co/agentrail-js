import { describe, expect, it } from 'vitest';

import {
  SessionTimeoutError,
  newSessionId,
  sessionCookie,
  sessionStartOf,
} from '../src/index.js';

describe('the session', () => {
  // Fails if someone mints another UUID version, or writes the time
  // anywhere but its first 48 bits: the edge and the browser script tell a
  // session's age only from its id, and would end every session at once, or
  // none.
  it('is a UUIDv7 that carries the time it was minted', () => {
    for (const now of [0, 1_790_000_000_123, 2 ** 48 - 1]) {
      const id = newSessionId(now);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(sessionStartOf(id)).toBe(now);
    }
    expect(sessionStartOf(crypto.randomUUID())).toBeNull();
  });

  // Fails if someone drops the check: a tag's `data-session-idle="30m"`
  // would write `Max-Age=NaN`, which browsers ignore, and its sessions
  // would never end, however long the visitor was idle.
  it('refuses an idle timeout a cookie cannot carry', () => {
    for (const idleTimeout of [Number('30m'), 0, 90.5, -60])
      expect(
        () => sessionCookie({ name: 'agentrail_session', idleTimeout }),
        String(idleTimeout),
      ).toThrow(SessionTimeoutError);
  });
});
