import { checkBrowserCall, checkBrowserPayloadCall } from 'agentrail-contract';
import { afterEach } from 'vitest';

import {
  start,
  type BrowserCall,
  type BrowserOptions,
  type BrowserPayloadCall,
} from '../../src/index.js';

export const KEY = 'ajp_public-key-of-the-browser-source';
export const COLLECTOR = 'https://collector.example.test/ingest/browser';
/** Where a payload call goes: the key in the query, never the body. */
export const PAYLOADS = `${COLLECTOR}/payloads?key=${encodeURIComponent(KEY)}`;
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
  answer: (url: string) => Response | Promise<Response> = () =>
    new Response('{}', { status: 200 }),
  {
    beacon = true,
    refuses = 0,
  }: { readonly beacon?: boolean; readonly refuses?: number } = {},
) {
  const fetched: Sent[] = [];
  const beacons: { url: string; data: Blob }[] = [];
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
      value: (url: string, data: Blob) => {
        if (refused < refuses) {
          refused += 1;
          return false;
        }
        beacons.push({ url, data });
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

  /** Every call the collector got, by fetch or beacon, each checked against what it takes. */
  async function bodiesTo(url: string): Promise<string[]> {
    return [
      ...fetched
        .filter((call) => call.url === url)
        .map((call) => call.body ?? ''),
      ...(await Promise.all(
        beacons
          .filter((beacon) => beacon.url === url)
          .map((beacon) => beacon.data.text()),
      )),
    ];
  }

  async function calls(): Promise<BrowserCall[]> {
    const bodies = await bodiesTo(COLLECTOR);
    // A call the collector would refuse fails the test that made it.
    return bodies.map((body) => {
      const call: unknown = JSON.parse(body);
      checkBrowserCall(call);
      return call as BrowserCall;
    });
  }

  /** Every payload call the collector got, by fetch or beacon, each checked against what it takes. */
  async function payloadCalls(): Promise<
    { readonly bytes: number; readonly call: BrowserPayloadCall }[]
  > {
    return (await bodiesTo(PAYLOADS)).map((body) => {
      const call: unknown = JSON.parse(body);
      checkBrowserPayloadCall(call);
      return {
        bytes: new TextEncoder().encode(body).byteLength,
        call: call as BrowserPayloadCall,
      };
    });
  }

  /** Sends what is queued, then every call the collector got. */
  async function sent(): Promise<BrowserCall[]> {
    agentrail.flush();
    return calls();
  }

  return { agentrail, fetched, beacons, calls, payloadCalls, sent };
}
