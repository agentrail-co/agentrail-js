import type { Page } from './wire.js';

/**
 * The session the edge set, and this tab. The edge mints the session cookie
 * and keeps it on every answer (`@agentrail/edge`), without `HttpOnly` so
 * this script reads it; on a site with no edge in front, the script mints it
 * the same way, and an edge added later keeps it.
 */

/** What the edge mints for a session, and all it keeps: a version 4 UUID. */
const MINTED_SESSION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const TAB_KEY = 'agentrail_tab';

/** The session's id: the edge's cookie, or one minted here as the edge would. */
export function sessionOf(document: Document, cookie: string): string {
  const found = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookie}=`))
    ?.slice(cookie.length + 1);
  if (found !== undefined && MINTED_SESSION.test(found)) return found;
  const minted = crypto.randomUUID();
  const secure = document.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${cookie}=${minted}; Path=/; SameSite=Lax${secure}`;
  return minted;
}

/**
 * This tab's id, kept for the tab's life in `sessionStorage`. Where storage
 * is refused (a sandboxed frame, storage blocked), every page is a tab of
 * its own.
 */
export function tabOf(window: Page): string {
  let storage: Storage;
  try {
    storage = window.sessionStorage;
  } catch (error) {
    // Reading `sessionStorage` itself throws where storage is denied.
    if (error instanceof DOMException) return crypto.randomUUID();
    throw error;
  }
  const kept = storage.getItem(TAB_KEY);
  if (kept !== null) return kept;
  const minted = crypto.randomUUID();
  storage.setItem(TAB_KEY, minted);
  return minted;
}

/** The page's clock, milliseconds since the epoch, finer than a millisecond. */
export function nowOf(window: Page): () => number {
  const { performance } = window;
  return () => performance.timeOrigin + performance.now();
}
