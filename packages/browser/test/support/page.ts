import {
  browserEventSchema,
  fingerprintSchema,
  frameBatchSchema,
} from '@argus/journey-linkage';
import { afterEach } from 'vitest';

import {
  start,
  type BrowserCall,
  type BrowserOptions,
} from '../../src/index.js';

export const KEY = 'ajp_public-key-of-the-browser-source';
export const COLLECTOR = 'https://collector.example.test/ingest/browser';
export const API = 'https://api.example.test';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string | null;
  readonly keepalive: boolean;
}

/**
 * The script on the test's page, with the collector and the site's API
 * stood in: every fetch the page makes is answered `answer`'s way and kept,
 * every beacon the browser queued kept, on a browser with `sendBeacon`
 * unless `beacon` is false, which refuses the first `refuses` beacons.
 * Undone after each test.
 */
export function onPage(
  options: Partial<BrowserOptions> = {},
  answer: (url: string) => Response = () => new Response('{}', { status: 200 }),
  {
    beacon = true,
    refuses = 0,
  }: { readonly beacon?: boolean; readonly refuses?: number } = {},
) {
  const fetched: Sent[] = [];
  const beacons: Blob[] = [];
  let refused = 0;
  // The test's own fetch, put back as it was after each test.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    fetched.push({
      url,
      // As the call goes: the init's headers replace the request's.
      headers: new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ),
      body: typeof init?.body === 'string' ? init.body : null,
      keepalive: init?.keepalive ?? false,
    });
    return Promise.resolve(answer(url));
  };
  if (beacon)
    Object.defineProperty(window.navigator, 'sendBeacon', {
      configurable: true,
      value: (_url: string, data: Blob) => {
        if (refused < refuses) {
          refused += 1;
          return false;
        }
        beacons.push(data);
        return true;
      },
    });
  const agentrail = start({
    key: KEY,
    collector: COLLECTOR,
    window,
    ...options,
  });
  cleanups.push(() => {
    agentrail.stop();
    window.fetch = realFetch;
    Reflect.deleteProperty(window.navigator, 'sendBeacon');
    document.cookie = 'agentrail_session=; Max-Age=0; Path=/';
    window.sessionStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  /** Every call the collector got, by fetch or beacon, read as it reads them. */
  async function calls(): Promise<BrowserCall[]> {
    const bodies = [
      ...fetched
        .filter((call) => call.url === COLLECTOR)
        .map((call) => call.body ?? ''),
      ...(await Promise.all(beacons.map((beacon) => beacon.text()))),
    ];
    // Read with the collector's own schemas: a call it would refuse fails
    // the test that made it.
    return bodies.map((body) => {
      const call = JSON.parse(body) as BrowserCall;
      for (const event of call.events) browserEventSchema.parse(event);
      for (const batch of call.behaviour) frameBatchSchema.parse(batch);
      for (const fingerprint of call.fingerprints)
        fingerprintSchema.parse(fingerprint);
      return call;
    });
  }

  /** Sends what is queued, then every call the collector got. */
  async function sent(): Promise<BrowserCall[]> {
    agentrail.flush();
    return calls();
  }

  return { agentrail, fetched, beacons, calls, sent };
}
