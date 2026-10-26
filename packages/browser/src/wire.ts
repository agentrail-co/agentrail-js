import type { AgentrailEvent, Component } from '@agentrail/core';

/**
 * What the browser script sends to the collector (`POST /ingest/browser`).
 * It goes as text, so a page sends it with no CORS preflight and with
 * `sendBeacon`, and the source's public key goes in the body, since a beacon
 * sets no header.
 */
export interface BrowserCall {
  /** The browser source's public key: it writes this source's events, nothing else. */
  readonly key: string;
  readonly component: Component;
  /** This tab's id, minted once a tab: whose clock its times are on. */
  readonly tab: string;
  /** Page views, first-party fetches and WebMCP tool calls. */
  readonly events: readonly AgentrailEvent[];
  readonly behaviour: readonly FrameBatch[];
  readonly fingerprints: readonly Fingerprint[];
}

/** Raw behaviour, a page's frames at a time. */
export interface FrameBatch {
  /** Minted here, so a batch sent again is the same batch. */
  readonly id: string;
  /** The page view the frames happened on: its event's id. */
  readonly page: string;
  readonly frames: readonly Frame[];
}

/**
 * The tab's fingerprint, read once: each component's value, or why it could
 * not be read. Named as FingerprintJS names them, so FP-Agent's vectoriser
 * reads it (`docs/research/agent-journey-correlation.md`, 15.4); read by
 * this package's own code, not FingerprintJS's.
 */
export interface Fingerprint {
  readonly id: string;
  readonly page: string;
  readonly components: Readonly<Record<string, FingerprintComponent>>;
}

export type FingerprintComponent =
  { readonly value: unknown } | { readonly error: string };

/** 1 when the browser says no person caused the event (`isTrusted` false). */
export type Untrusted = 0 | 1;

/**
 * A key as kept: never which key, only its class. Structural keys move
 * through a form (Tab, Enter, the arrows); editing keys take text back
 * (Backspace, Delete).
 */
export const KEY_CLASSES = { other: 0, structural: 1, editing: 2 } as const;
export type KeyClass = (typeof KEY_CLASSES)[keyof typeof KEY_CLASSES];

/** How a pointer went down: what decides which features mean anything. */
export const POINTER_TYPES = { mouse: 0, touch: 1, pen: 2, other: 3 } as const;
export type PointerTypeCode =
  (typeof POINTER_TYPES)[keyof typeof POINTER_TYPES];

/**
 * One raw behaviour event, its time always last (the page's clock,
 * milliseconds since the epoch), as FP-Agent's own frames end with theirs,
 * and just before it whether the browser says no person caused it.
 * `target` is 0 for the document, else an element's number on this tab,
 * given in order of first use: never a selector or anything of the DOM.
 * Coordinates are the viewport's (`clientX`, `clientY`).
 *
 * - `mm` a mouse move, with how many raw moves the browser coalesced into
 *   it (0 when no pointer event came before it: dispatched, not moved);
 * - `md`, `mu`, `ck` a button down, up, and a click, with whether a click
 *   was on a link;
 * - `kd`, `ku` a key down and up: the press it belongs to (numbered on the
 *   tab, so a key's down and up pair without naming it), whether the
 *   browser repeated it, and its class;
 * - `sc`, `se` a scroll and its end, at the scrolled offset; for the
 *   document, how far down it reaches (0 to 1), else -1;
 * - `wh` a wheel turn, its size as a bucket (0 none, 1 under 10, 2 under
 *   100, 3 more);
 * - `p`, `i`, `c` a paste, an input and a change: that they happened, never
 *   what;
 * - `pd` a pointer going down, and its type;
 * - `fo`, `bl` the window's focus and blur; `vs` the page shown (1) or
 *   hidden (0).
 */
export type Frame =
  | readonly [
      'mm',
      target: number,
      x: number,
      y: number,
      coalesced: number,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly [
      'md' | 'mu',
      target: number,
      button: number,
      x: number,
      y: number,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly [
      'ck',
      target: number,
      button: number,
      x: number,
      y: number,
      link: 0 | 1,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly [
      'kd' | 'ku',
      target: number,
      press: number,
      repeat: 0 | 1,
      key: KeyClass,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly [
      'sc' | 'se',
      target: number,
      x: number,
      y: number,
      depth: number,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly [
      'wh',
      target: number,
      size: 0 | 1 | 2 | 3,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly ['p' | 'i' | 'c', target: number, untrusted: Untrusted, t: number]
  | readonly [
      'pd',
      target: number,
      pointer: PointerTypeCode,
      untrusted: Untrusted,
      t: number,
    ]
  | readonly ['fo' | 'bl', untrusted: Untrusted, t: number]
  | readonly ['vs', visible: 0 | 1, untrusted: Untrusted, t: number];

export type FrameType = Frame[0];

/** A page's window, with the constructors it carries (`Element`, `XMLHttpRequest`). */
export type Page = Window & typeof globalThis;

/** What a browser event is, as its `kind`. */
export const BROWSER_EVENT_KINDS = {
  pageView: 'page.view',
  fetch: 'http.client',
  toolExecuted: 'agent.tool.executed',
} as const;
