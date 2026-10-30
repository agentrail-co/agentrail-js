import { newSessionId, type SessionCookie } from 'agentrail-core';

import type { Page } from './wire.js';

/**
 * The session the edge set, and this tab. The edge mints the session cookie
 * and writes it again on every answer (`agentrail-edge`), without
 * `HttpOnly` so this script reads it; on a site with no edge in front, the
 * script mints it the same way, and an edge added later keeps it. Both
 * follow `agentrail-core`'s rules: a session ends after its idle timeout
 * without a request, and a day after it began.
 */

const TAB_KEY = 'agentrail_tab';

/**
 * The session a page view goes on with: the cookie's while it is live, or
 * one minted here as the edge would. Written again either way, so the
 * session lasts another idle timeout.
 */
export function sessionOf(document: Document, cookie: SessionCookie): string {
  const now = Date.now();
  const session = cookie.read(document.cookie, now) ?? newSessionId(now);
  document.cookie = cookie.write(
    session,
    document.location.protocol === 'https:',
  );
  return session;
}

/**
 * Keeps a value for the tab, where the page's storage has room: a full
 * storage (`QuotaExceededError`) keeps nothing, and the page goes on.
 */
function keep(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}

/**
 * This tab's id, kept for the tab's life in `sessionStorage`. Where storage
 * is refused (a sandboxed frame, storage blocked) or full, every page is a
 * tab of its own.
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
  keep(storage, TAB_KEY, minted);
  return minted;
}

/**
 * Whether this tab has done something once already, by a mark it keeps in
 * `sessionStorage`; `mark` sets it. Where storage is refused or full, every
 * page is a tab of its own, and has not.
 */
export function doneOnTab(
  window: Page,
  key: string,
): {
  readonly done: boolean;
  readonly mark: () => void;
} {
  let storage: Storage;
  try {
    storage = window.sessionStorage;
  } catch (error) {
    // Reading `sessionStorage` itself throws where storage is denied.
    if (error instanceof DOMException)
      return { done: false, mark: () => undefined };
    throw error;
  }
  return {
    done: storage.getItem(key) !== null,
    mark: () => {
      keep(storage, key, '1');
    },
  };
}

/** The page's clock, milliseconds since the epoch, finer than a millisecond. */
export function nowOf(window: Page): () => number {
  const { performance } = window;
  return () => performance.timeOrigin + performance.now();
}
