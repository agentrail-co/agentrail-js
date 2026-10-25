import type { AgentrailEvent, Component } from '@agentrail/core';

import type { BrowserCall, FrameBatch, Fingerprint } from './wire.js';

/** The collector answered a call with a refusal: its status says why. */
export class BrowserCollectorRefusedError extends Error {
  override readonly name = 'BrowserCollectorRefusedError';
  constructor(readonly status: number) {
    super(`The collector refused the call (${String(status)}).`);
  }
}

/** A call could not be delivered: the network failed, or no beacon was queued. */
export class BrowserCollectorUnavailableError extends Error {
  override readonly name = 'BrowserCollectorUnavailableError';
}

/**
 * The most one call holds. A `keepalive` fetch and a beacon share one budget
 * of 64 KiB in flight per page; this leaves room for two calls under way.
 */
const MAX_CALL_BYTES = 30_000;
/** How long a queued item waits before a call goes, at most. */
const FLUSH_MS = 5_000;
/** How many queued events send a call at once. */
const FLUSH_EVENTS = 50;

export interface TransportOptions {
  readonly endpoint: string;
  readonly key: string;
  readonly tab: string;
  readonly component: Component;
  /** The page's fetch as it was before this script wrapped it. */
  readonly fetch: typeof fetch;
  /** `navigator.sendBeacon`, where the browser has it. */
  readonly beacon: ((url: string, data: Blob) => boolean) | null;
  readonly onError: (error: Error) => void;
  /** Called first on every send, so what is buffered elsewhere joins it. */
  readonly beforeSend: () => void;
}

export interface Transport {
  event(event: AgentrailEvent): void;
  behaviour(batch: FrameBatch): void;
  fingerprint(fingerprint: Fingerprint): void;
  /**
   * Sends everything queued. A beacon outlives the page, so it is what a
   * page being hidden sends with; a fetch reports what the collector said.
   */
  send(how: 'fetch' | 'beacon'): void;
  stop(): void;
}

const encoder = new TextEncoder();

export function createTransport(options: TransportOptions): Transport {
  let events: AgentrailEvent[] = [];
  let behaviour: FrameBatch[] = [];
  let fingerprints: Fingerprint[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const base = {
    key: options.key,
    component: options.component,
    tab: options.tab,
  };
  const sizeOf = (call: BrowserCall) =>
    encoder.encode(JSON.stringify(call)).byteLength;

  /** The queue as calls, each under the budget, items in the order they came. */
  function calls(): BrowserCall[] {
    const none = { ...base, events: [], behaviour: [], fingerprints: [] };
    const items: BrowserCall[] = [
      ...events.map((event) => ({ ...none, events: [event] })),
      ...behaviour.map((batch) => ({ ...none, behaviour: [batch] })),
      ...fingerprints.map((fingerprint) => ({
        ...none,
        fingerprints: [fingerprint],
      })),
    ];
    const packed: BrowserCall[] = [];
    let current: BrowserCall | null = null;
    for (const item of items) {
      const joined: BrowserCall =
        current === null
          ? item
          : {
              ...base,
              events: [...current.events, ...item.events],
              behaviour: [...current.behaviour, ...item.behaviour],
              fingerprints: [...current.fingerprints, ...item.fingerprints],
            };
      // An item alone over the budget still goes, alone: the collector, not
      // this script, says whether it is too large.
      if (current !== null && sizeOf(joined) > MAX_CALL_BYTES) {
        packed.push(current);
        current = item;
      } else current = joined;
    }
    if (current !== null) packed.push(current);
    return packed;
  }

  function deliver(call: BrowserCall, how: 'fetch' | 'beacon'): void {
    const body = JSON.stringify(call);
    if (how === 'beacon' && options.beacon !== null) {
      const queued = options.beacon(
        options.endpoint,
        new Blob([body], { type: 'text/plain;charset=UTF-8' }),
      );
      if (!queued)
        options.onError(
          new BrowserCollectorUnavailableError(
            'The browser did not queue the beacon.',
          ),
        );
      return;
    }
    options
      .fetch(options.endpoint, {
        method: 'POST',
        // Text, so a cross-origin call needs no preflight.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        keepalive: true,
        credentials: 'omit',
      })
      .then(
        (response) => {
          if (!response.ok)
            options.onError(new BrowserCollectorRefusedError(response.status));
        },
        (error: unknown) => {
          // Fetch rejects only when the call never got an answer.
          if (!(error instanceof TypeError)) throw error;
          options.onError(
            new BrowserCollectorUnavailableError(error.message, {
              cause: error,
            }),
          );
        },
      );
  }

  function send(how: 'fetch' | 'beacon'): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    options.beforeSend();
    const pending = calls();
    events = [];
    behaviour = [];
    fingerprints = [];
    for (const call of pending) deliver(call, how);
  }

  function queued(): void {
    if (stopped) return;
    if (events.length >= FLUSH_EVENTS) send('fetch');
    else
      timer ??= setTimeout(() => {
        timer = null;
        send('fetch');
      }, FLUSH_MS);
  }

  return {
    event(event) {
      events.push(event);
      queued();
    },
    behaviour(batch) {
      behaviour.push(batch);
      queued();
    },
    fingerprint(fingerprint) {
      fingerprints.push(fingerprint);
      queued();
    },
    send,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
