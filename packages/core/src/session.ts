import { hexOf } from './id.js';

/**
 * A visitor's session, kept as web analytics and PostHog keep one: it ends
 * after 30 minutes without a request, and lasts 24 hours at most. The edge
 * and the browser script share it in one cookie, which each writes again
 * with the idle timeout as its `Max-Age` on every answer or page view, so the
 * browser drops it once the visitor has been idle that long. The id is a
 * UUIDv7, which carries the time it was minted, so either tells a session's
 * age from its id and keeps nothing else.
 */

/** Seconds without a request after which a session ends, unless a site sets its own. */
const SESSION_IDLE_TIMEOUT = 30 * 60;

/** How long a session lasts at most, idle or not, in milliseconds. */
const SESSION_MAX_LENGTH = 24 * 60 * 60 * 1000;

/** A UUIDv7: a 48-bit time in milliseconds, the version, the variant, the rest random. */
const SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** An idle timeout a cookie cannot carry. */
export class SessionTimeoutError extends Error {
  override readonly name = 'SessionTimeoutError';
}

/**
 * A session id minted at `now`, milliseconds since the epoch, from this
 * runtime's strong random source. It needs no secure context, as
 * `crypto.randomUUID` does.
 */
export function newSessionId(now: number): string {
  const time = Math.floor(now).toString(16).padStart(12, '0');
  const random = hexOf(crypto.getRandomValues(new Uint8Array(10)));
  // The variant's two bits are 10; the two after them are random.
  const variant = (8 | (Number.parseInt(random.charAt(3), 16) & 3)).toString(
    16,
  );
  return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${variant}${random.slice(4, 7)}-${random.slice(7, 19)}`;
}

/** When a session was minted, from its id; null for an id `newSessionId` could not have minted. */
export function sessionStartOf(id: string): number | null {
  if (!SESSION_ID.test(id)) return null;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

export interface SessionCookieOptions {
  readonly name: string;
  /** Seconds without a request after which the session ends; 30 minutes by default. */
  readonly idleTimeout?: number | undefined;
  /**
   * The domain the session is shared across, as `example.com` for
   * `docs.example.com` and `app.example.com`; the one host that set it
   * when absent.
   */
  readonly domain?: string | undefined;
}

export interface SessionCookie {
  /**
   * The session a `Cookie` header or `document.cookie` holds, when it is one
   * to go on with at `now`: minted as `newSessionId` mints, less than 24
   * hours before. One minted after `now` is kept: a page's clock may run
   * ahead of the edge's, and a page mints too.
   */
  read(cookies: string, now: number): string | null;
  /**
   * The `Set-Cookie` value, or the `document.cookie` write, that keeps
   * `session` for another idle timeout. Never `HttpOnly`: the browser script
   * reads it.
   */
  write(session: string, secure: boolean): string;
}

/** The session cookie a component reads and writes. */
export function sessionCookie(options: SessionCookieOptions): SessionCookie {
  const { name, idleTimeout = SESSION_IDLE_TIMEOUT, domain } = options;
  if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1)
    throw new SessionTimeoutError(
      `A session's idle timeout is a whole number of seconds, at least 1, not ${String(idleTimeout)}.`,
    );
  return {
    read(cookies, now) {
      for (const part of cookies.split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key !== name) continue;
        const session = value.join('=');
        const start = sessionStartOf(session);
        return start !== null && now - start < SESSION_MAX_LENGTH
          ? session
          : null;
      }
      return null;
    },
    write(session, secure) {
      return [
        `${name}=${session}`,
        'Path=/',
        `Max-Age=${String(idleTimeout)}`,
        ...(domain === undefined ? [] : [`Domain=${domain}`]),
        'SameSite=Lax',
        ...(secure ? ['Secure'] : []),
      ].join('; ');
    },
  };
}
