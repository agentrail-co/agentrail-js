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
}

/**
 * The script on the test's page, with the collector and the site's API
 * stood in: every fetch the page makes is answered `answer`'s way and kept,
 * every beacon kept. Undone after each test.
 */
export function onPage(
  options: Partial<BrowserOptions> = {},
  answer: (url: string) => Response = () => new Response('{}', { status: 200 }),
) {
  const fetched: Sent[] = [];
  const beacons: Blob[] = [];
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
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return Promise.resolve(answer(url));
  };
  Object.defineProperty(window.navigator, 'sendBeacon', {
    configurable: true,
    value: (_url: string, data: Blob) => {
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
    return bodies.map((body) => JSON.parse(body) as BrowserCall);
  }

  /** Sends what is queued, then every call the collector got. */
  async function sent(): Promise<BrowserCall[]> {
    agentrail.flush();
    return calls();
  }

  return { agentrail, fetched, beacons, calls, sent };
}
