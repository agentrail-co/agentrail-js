import { checkBrowserCall } from 'agentrail-contract';
import { describe, expect, it, vi } from 'vitest';

import {
  BrowserCollectorRefusedError,
  BrowserCollectorUnavailableError,
  type BrowserCall,
  type FingerprintComponent,
} from '../src/index.js';
import { createTransport } from '../src/transport.js';
import { COLLECTOR, KEY, onPage } from './support/page.js';

/** What FP-Agent's vectoriser reads of a fingerprint, by component name. */
const VECTORISED = [
  'audio',
  'colorDepth',
  'colorGamut',
  'contrast',
  'cookiesEnabled',
  'deviceMemory',
  'forcedColors',
  'hardwareConcurrency',
  'hdr',
  'indexedDB',
  'invertedColors',
  'localStorage',
  'monochrome',
  'openDatabase',
  'platform',
  'reducedMotion',
  'sessionStorage',
  'timezone',
  'osCpu',
  'vendor',
  'vendorFlavors',
  'fonts',
  'languages',
  'plugins',
  'screenResolution',
  'screenFrame',
  'touchSupport',
  'math',
  'fontPreferences',
];

describe('sending to the collector', () => {
  // Fails if someone sends a call as JSON (every cross-origin call would
  // wait on a preflight, and a beacon could not carry it), puts the key in
  // a header (a beacon sets none), or lets one call outgrow what a page may
  // have in flight as it closes.
  it('sends text the browser sends as it is, the key in the body, each call within what a closing page may send', async () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    for (let index = 0; index < 120; index += 1)
      window.history.pushState(
        null,
        '',
        `/page/${String(index)}/${'x'.repeat(200)}`,
      );
    const calls = await site.sent();
    const sent = site.fetched.filter((call) => call.url === COLLECTOR);

    expect(calls.flatMap((call) => call.events)).toHaveLength(121);
    expect(sent.length).toBeGreaterThan(1);
    for (const call of sent) {
      expect(call.headers.get('content-type')).toBe('text/plain;charset=UTF-8');
      expect(
        new TextEncoder().encode(call.body ?? '').byteLength,
      ).toBeLessThanOrEqual(30_000);
    }
  });

  // Fails if someone sends the queue only at fifty events or five seconds:
  // a page whose steps are large would queue more than its closing beacons
  // may carry, and the browser would refuse what is past the budget.
  it('sends a call as soon as the queue holds a call of it', () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    for (let index = 0; index < 20; index += 1)
      window.history.pushState(
        null,
        '',
        `/page/${String(index)}/${'x'.repeat(2_000)}`,
      );

    expect(
      site.fetched.filter((call) => call.url === COLLECTOR).length,
    ).toBeGreaterThan(0);
  });

  // Fails if someone drops what the browser would not queue as a beacon
  // (the page's budget taken, as its own keepalive calls can): a page
  // hidden then, and shown again, would never send its last steps.
  it('keeps what the browser would not queue as a beacon, and sends it soon after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const errors: Error[] = [];
      const site = onPage(
        {
          behaviour: false,
          fingerprint: false,
          onError: (error) => errors.push(error),
        },
        undefined,
        { refuses: 1 },
      );
      window.history.pushState(null, '', '/next');
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      vi.advanceTimersByTime(5_000);
      const calls = await site.calls();

      expect(site.beacons).toEqual([]);
      expect(
        calls.flatMap((call) => call.events.map((event) => event.http?.path)),
      ).toEqual(['/', '/next']);
      expect(errors).toEqual([expect.any(BrowserCollectorUnavailableError)]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fails if someone sends a hidden page's last steps by fetch alone (a
  // closing page cancels it), or sends them twice.
  it('sends what is queued as a beacon when the page goes, once', async () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));

    expect(site.beacons).toHaveLength(1);
    expect(
      (await site.calls()).flatMap((call) =>
        call.events.map((event) => event.kind),
      ),
    ).toEqual(['page.view']);
  });

  // Fails if someone lets the frames a send gathers start a send of their
  // own: once the queue fills a call with frames buffered, every send would
  // call the next until the stack overflowed, and the page's own fetch
  // would reject.
  it('sends the frames buffered when the queue fills a call in that one send', async () => {
    const site = onPage({ fingerprint: false });
    await site.agentrail.ready;
    window.dispatchEvent(
      new MouseEvent('mousemove', { clientX: 1, clientY: 2, bubbles: true }),
    );
    for (let index = 0; index < 49; index += 1)
      await window.fetch(`/v1/items/${String(index)}`);
    const calls = await site.calls();

    expect(calls.flatMap((call) => call.events).length).toBeGreaterThan(0);
    expect(
      calls.flatMap((call) =>
        call.behaviour.flatMap((batch) => batch.frames.map((f) => f[0])),
      ),
    ).toEqual(['mm']);
  });

  // Fails if someone sends an open page's calls with `keepalive` (slow
  // answers would fill the budget a closing page's last calls go in), or a
  // closing page's without it where there is no beacon (the browser would
  // cancel them as the page goes).
  it("keeps only a closing page's fetch alive past the page, where there is no beacon", () => {
    const site = onPage({ behaviour: false, fingerprint: false }, undefined, {
      beacon: false,
    });
    site.agentrail.flush();
    window.history.pushState(null, '', '/next');
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    const sent = site.fetched.filter((call) => call.url === COLLECTOR);

    expect(sent.map((call) => call.keepalive)).toEqual([false, true]);
  });

  // Fails if someone drops what the collector answered (a refused key would
  // fail every call unseen), or tells nobody of it by default: a site that
  // starts the script itself with a revoked key would lose every call, and
  // nothing on the page would say so. Or if the default still speaks when the
  // site gave its own `onError`.
  it.each([
    ["to the site's onError", true],
    ["on the page's console when the site gave none", false],
  ] as const)(
    'tells of a call the collector refused %s',
    async (_, ownOnError) => {
      const errors: Error[] = [];
      const warnings: unknown[][] = [];
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation((...line: unknown[]) => {
          warnings.push(line);
        });
      try {
        const site = onPage(
          {
            behaviour: false,
            fingerprint: false,
            ...(ownOnError ? { onError: (error) => errors.push(error) } : {}),
          },
          () =>
            new Response('{"code":"AUTHENTICATION_REQUIRED"}', { status: 401 }),
        );
        await site.sent();
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (ownOnError) {
          expect(errors).toEqual([expect.any(BrowserCollectorRefusedError)]);
          expect((errors[0] as BrowserCollectorRefusedError).status).toBe(401);
          expect(warnings).toEqual([]);
        } else
          expect(warnings).toEqual([
            ['Agentrail: The collector refused the call (401).'],
          ]);
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe('turning parts off, and the fingerprint', () => {
  // Fails if someone records behaviour or a fingerprint a site turned off:
  // a site that withheld consent would send them.
  it('sends no behaviour and no fingerprint where the site turned them off', async () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    await site.agentrail.ready;
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    const calls = await site.sent();

    expect(
      calls.flatMap((call) => [...call.behaviour, ...call.fingerprints]),
    ).toEqual([]);
  });

  // Fails if someone drops or renames a component FP-Agent's vectoriser
  // reads (its columns would read as never seen), lets one the browser
  // cannot read stop the rest, or reads it again on every page of a tab
  // (each page of a visit would send the same browser's fingerprint again).
  it('reads every component the vectoriser reads, each a value or why not, once a tab', async () => {
    const site = onPage({ behaviour: false });
    await site.agentrail.ready;
    const [fingerprint, ...more] = (await site.sent()).flatMap(
      (call) => call.fingerprints,
    );
    site.agentrail.stop();
    const nextPage = onPage({ behaviour: false });
    await nextPage.agentrail.ready;
    expect(
      (await nextPage.sent()).flatMap((call) => call.fingerprints),
    ).toEqual([]);
    const components: Record<string, FingerprintComponent> =
      fingerprint?.components ?? {};

    expect(more).toEqual([]);
    expect(Object.keys(components)).toEqual(expect.arrayContaining(VECTORISED));
    for (const name of VECTORISED)
      expect(components[name], name).toSatisfy(
        (value: FingerprintComponent) => 'value' in value || 'error' in value,
      );
    // What this DOM has, it reports; what it lacks, it says so.
    expect(components.hardwareConcurrency).toEqual({
      value: navigator.hardwareConcurrency,
    });
    expect(components.audio).toEqual({ error: 'unsupported' });
  });

  // Fails if someone reads the fingerprint after the site stopped the
  // script (a site that stops it as consent is withdrawn would still have
  // the browser read), or keeps one read as stop came as read: it goes into
  // a stopped queue that never sends, and every later page of the tab skips
  // it as sent.
  it('neither reads nor keeps a fingerprint once stopped, and the next start reads it', async () => {
    let reads = 0;
    let onRead = (): void => undefined;
    Object.defineProperty(window.navigator, 'hardwareConcurrency', {
      configurable: true,
      get: () => {
        reads += 1;
        onRead();
        return 8;
      },
    });
    try {
      const first = onPage({ behaviour: false });
      first.agentrail.stop();
      await first.agentrail.ready;
      expect(reads).toBe(0);

      const second = onPage({ behaviour: false });
      onRead = () => {
        onRead = () => undefined;
        second.agentrail.stop();
      };
      await second.agentrail.ready;
      const third = onPage({ behaviour: false });
      await third.agentrail.ready;

      expect(
        (await third.sent()).flatMap((call) => call.fingerprints),
      ).toHaveLength(1);
    } finally {
      Reflect.deleteProperty(window.navigator, 'hardwareConcurrency');
    }
  });
});

describe('packing calls', () => {
  // Fails if someone packs calls by size alone: the collector refuses a
  // call of more than 40 behaviour batches, and every item in it is lost.
  it('puts no more of each in a call than the collector takes', () => {
    const bodies: string[] = [];
    const transport = createTransport({
      endpoint: COLLECTOR,
      key: KEY,
      tab: 'tab-1',
      component: { name: 'agentrail-browser', version: '0', surfaces: [] },
      fetch: (_url, init) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(new Response('{}'));
      },
      beacon: null,
      onError: (error) => {
        throw error;
      },
      beforeSend: () => undefined,
    });
    const page = crypto.randomUUID();
    for (let index = 0; index < 45; index += 1)
      transport.behaviour({
        id: crypto.randomUUID(),
        page,
        frames: [['mm', 0, index, 0, 0, 0, index]],
      });
    transport.send('fetch');
    transport.stop();
    const calls = bodies.map((body) => {
      const call: unknown = JSON.parse(body);
      checkBrowserCall(call);
      return call as BrowserCall;
    });

    expect(calls.flatMap((call) => call.behaviour)).toHaveLength(45);
    expect(
      Math.max(...calls.map((call) => call.behaviour.length)),
    ).toBeLessThanOrEqual(40);
  });
});
