import type { AgentrailEvent, Component } from 'agentrail-core';

import type { BrowserCall, FrameBatch, Fingerprint } from './wire.js';

/** The collector answered a call with a refusal: its status says why. */
export class BrowserCollectorRefusedError extends Error {
  override readonly name = 'BrowserCollectorRefusedError';
  constructor(readonly status: number) {
    super(`The collector refused the call (${String(status)}).`);
  }
}

/**
 * A call could not be delivered: the network failed, or the browser would
 * not queue its beacon (what that beacon held waits for the next send).
 */
export class BrowserCollectorUnavailableError extends Error {
  override readonly name = 'BrowserCollectorUnavailableError';
}

/**
 * The most one call holds. A closing page's beacons (or `keepalive` fetches,
 * where there is no beacon) share one budget of 64 KiB in flight; this
 * leaves room for two calls under way.
 */
export const MAX_CALL_BYTES = 30_000;
/**
 * The most of each one call holds: the collector refuses a call with more
 * (`journeyBrowserCallSchema`, apps/api/src/modules/journey-ingest/schema.ts).
 */
const MAX_CALL_EVENTS = 200;
const MAX_CALL_BATCHES = 40;
const MAX_CALL_FINGERPRINTS = 8;
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
   * What the browser would not queue as a beacon stays queued, and goes by
   * fetch after a while unless a send takes it first.
   */
  send(how: 'fetch' | 'beacon'): void;
  stop(): void;
}

const encoder = new TextEncoder();

export function createTransport(options: TransportOptions): Transport {
  let events: AgentrailEvent[] = [];
  let behaviour: FrameBatch[] = [];
  let fingerprints: Fingerprint[] = [];
  /** What is queued would take about this much of a call. */
  let queuedBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // What `beforeSend` hands over joins this send; it never starts another.
  let gathering = false;

  const base = {
    key: options.key,
    component: options.component,
    tab: options.tab,
  };
  const sizeOf = (item: unknown) =>
    encoder.encode(JSON.stringify(item)).byteLength;
  const overfull = (call: BrowserCall) =>
    call.events.length > MAX_CALL_EVENTS ||
    call.behaviour.length > MAX_CALL_BATCHES ||
    call.fingerprints.length > MAX_CALL_FINGERPRINTS ||
    sizeOf(call) > MAX_CALL_BYTES;

  /**
   * The queue as calls, each under the budget and what the collector takes,
   * items in the order they came.
   */
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
      if (current !== null && overfull(joined)) {
        packed.push(current);
        current = item;
      } else current = joined;
    }
    if (current !== null) packed.push(current);
    return packed;
  }

  /** Hands a call to the browser; false when it would not queue its beacon. */
  function deliver(call: BrowserCall, how: 'fetch' | 'beacon'): boolean {
    const body = JSON.stringify(call);
    if (how === 'beacon' && options.beacon !== null)
      return options.beacon(
        options.endpoint,
        new Blob([body], { type: 'text/plain;charset=UTF-8' }),
      );
    options
      .fetch(options.endpoint, {
        method: 'POST',
        // Text, so a cross-origin call needs no preflight.
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        body,
        // Only a closing page's fetch outlives it: an open page's sends stay
        // out of the budget its last calls go in.
        keepalive: how === 'beacon',
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
    return true;
  }

  function later(): void {
    timer ??= setTimeout(() => {
      timer = null;
      send('fetch');
    }, FLUSH_MS);
  }

  function send(how: 'fetch' | 'beacon'): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    gathering = true;
    try {
      options.beforeSend();
    } finally {
      gathering = false;
    }
    // A page's budget for beacons can be full (its own `keepalive` calls
    // take it too): what the browser would not queue stays queued, in the
    // order it came, for a page that comes back to send.
    const refused = calls().filter((call) => !deliver(call, how));
    events = refused.flatMap((call) => call.events);
    behaviour = refused.flatMap((call) => call.behaviour);
    fingerprints = refused.flatMap((call) => call.fingerprints);
    queuedBytes = refused.reduce((total, call) => total + sizeOf(call), 0);
    if (refused.length === 0) return;
    const beacons =
      refused.length === 1 ? 'a beacon' : `${String(refused.length)} beacons`;
    options.onError(
      new BrowserCollectorUnavailableError(
        `The browser did not queue ${beacons}; what it held waits for the next send.`,
      ),
    );
    if (!stopped) later();
  }

  function queued(item: unknown): void {
    queuedBytes += sizeOf(item);
    if (stopped || gathering) return;
    // A call's worth goes at once, so a page hidden next has at most about
    // one call left to send as a beacon.
    if (events.length >= FLUSH_EVENTS || queuedBytes >= MAX_CALL_BYTES)
      send('fetch');
    else later();
  }

  return {
    event(event) {
      events.push(event);
      queued(event);
    },
    behaviour(batch) {
      behaviour.push(batch);
      queued(batch);
    },
    fingerprint(fingerprint) {
      fingerprints.push(fingerprint);
      queued(fingerprint);
    },
    send,
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
