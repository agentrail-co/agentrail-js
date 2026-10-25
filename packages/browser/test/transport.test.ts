import { describe, expect, it } from 'vitest';

import {
  BrowserCollectorRefusedError,
  type FingerprintComponent,
} from '../src/index.js';
import { COLLECTOR, onPage } from './support/page.js';

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

  // Fails if someone drops what the collector answered: a refused key would
  // fail every call unseen.
  it('tells of a call the collector refused', async () => {
    const errors: Error[] = [];
    const site = onPage(
      {
        behaviour: false,
        fingerprint: false,
        onError: (error) => errors.push(error),
      },
      () => new Response('{"code":"AUTHENTICATION_REQUIRED"}', { status: 401 }),
    );
    await site.sent();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([expect.any(BrowserCollectorRefusedError)]);
    expect((errors[0] as BrowserCollectorRefusedError).status).toBe(401);
  });
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
  // reads (its columns would read as never seen), or lets one the browser
  // cannot read stop the rest.
  it('reads every component the vectoriser reads, each a value or why not, once a tab', async () => {
    const site = onPage({ behaviour: false });
    await site.agentrail.ready;
    const [fingerprint, ...more] = (await site.sent()).flatMap(
      (call) => call.fingerprints,
    );
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
});
