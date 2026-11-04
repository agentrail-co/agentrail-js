import {
  linkMarker,
  newMarker,
  newSessionId,
  sessionStartOf,
} from 'agentrail-core';
import { describe, expect, it, vi } from 'vitest';

import { BrowserAlreadyStartedError, start } from '../src/index.js';
import { nowOf } from '../src/session.js';
import type { Page } from '../src/wire.js';
import { API, COLLECTOR, KEY, onPage } from './support/page.js';

const SESSION = newSessionId(Date.now());

/** The events the collector got. */
async function eventsOf(site: ReturnType<typeof onPage>) {
  return (await site.sent()).flatMap((call) => call.events);
}

describe("the page's clock", () => {
  // Fails if someone puts event times back on `timeOrigin + performance.now()`:
  // it stops while a device sleeps, so a tab left open stamps its events hours
  // in the past, and a linking run reopens every journey back to them.
  it('stays on the wall clock when the performance clock stopped while the device slept', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      let elapsed = 5_000;
      const now = nowOf({ performance: { now: () => elapsed } } as Page);
      expect(now()).toBe(1_800_000_000_000);

      vi.setSystemTime(1_800_000_000_000 + 3_600_000);
      elapsed += 20;

      expect(Math.abs(now() - Date.now())).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fails if someone reads the clock from `Date.now()` alone: whole
  // milliseconds would flatten the timing the behaviour features read.
  it('keeps the finer time between two readings', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    try {
      let elapsed = 100.25;
      const now = nowOf({ performance: { now: () => elapsed } } as Page);
      const first = now();
      elapsed = 100.75;

      expect(now() - first).toBeCloseTo(0.5, 6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the browser script', () => {
  // Fails if someone records the page's whole query (a token in it would
  // leave the page), drops the marker it was reached by (the engine could
  // not join the page to the link that led to it), takes the session from
  // anywhere but the edge's cookie, or puts the page on another clock than
  // its tab's.
  it('records a page view with the markers it was reached by, under the session the edge set and its tab', async () => {
    const marker = linkMarker(newMarker(), 0);
    document.cookie = `agentrail_session=${SESSION}; Path=/`;
    window.history.replaceState(
      null,
      '',
      `/docs/start?h=${marker}&utm_source=x&token=secret`,
    );
    const site = onPage({
      behaviour: false,
      fingerprint: false,
      queryAllowlist: ['utm_source'],
    });
    const [view] = await eventsOf(site);
    const [call] = await site.calls();

    expect(view).toMatchObject({
      surface: 'browser',
      kind: 'page.view',
      clock: 'browser',
      session: { id: SESSION, previousId: null },
      http: {
        method: 'GET',
        host: 'localhost:3000',
        path: `/docs/start?h=${marker}&utm_source=x`,
      },
      markers: { served: [], seen: [marker] },
      redactions: [{ field: 'http.path', reason: 'query_outside_allowlist' }],
      actor: { egress: null, userAgent: navigator.userAgent, client: null },
    });
    expect(view?.resource.serviceInstanceId).toBe(call?.tab);
    expect(call).toMatchObject({
      key: KEY,
      component: { name: 'agentrail-browser', surfaces: ['browser'] },
    });
    expect(JSON.stringify(call)).not.toContain('secret');
  });

  // Fails if someone stops counting a single-page app's routes as page
  // views (every later step would sit under the first page), or counts a
  // replaced history entry as one (a router's redirect would split a page).
  it('records each route a single-page app pushes or goes back to, under a trace of its own, and not a replaced entry', async () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    window.history.pushState(null, '', '/pricing');
    window.history.replaceState(null, '', '/pricing?tab=2');
    window.history.pushState(null, '', '/signup');
    window.dispatchEvent(new PopStateEvent('popstate'));
    const views = await eventsOf(site);

    expect(views.map((view) => view.http?.path)).toEqual([
      '/',
      '/pricing',
      '/signup',
      '/signup',
    ]);
    expect(new Set(views.map((view) => view.span?.traceId)).size).toBe(4);
  });

  // Fails if someone mints a session in another form than the edge's (the
  // edge would replace it, and the page and its requests would hold two),
  // keeps a cookie the edge could not have set or a session a day old (a
  // session would never end), or mints a tab per page (a reload would be
  // another clock).
  it('mints the session as the edge does when there is none, replaces one the edge could not have set or a day old, and keeps the tab across a reload', async () => {
    const dayOld = newSessionId(Date.now() - 25 * 60 * 60 * 1000);
    for (const replaced of ['forged', crypto.randomUUID(), dayOld]) {
      document.cookie = `agentrail_session=${replaced}; Path=/`;
      const minted = Date.now();
      const first = onPage({ behaviour: false, fingerprint: false });
      const [before] = await eventsOf(first);
      first.agentrail.stop();
      const second = onPage({ behaviour: false, fingerprint: false });
      const [after] = await eventsOf(second);
      second.agentrail.stop();

      const session = before?.session?.id ?? '';
      expect(sessionStartOf(session), replaced).toBeGreaterThanOrEqual(minted);
      expect(document.cookie, replaced).toContain(
        `agentrail_session=${session}`,
      );
      expect(after?.session?.id, replaced).toBe(session);
      expect(after?.resource.serviceInstanceId, replaced).toBe(
        before?.resource.serviceInstanceId,
      );
    }
  });

  // Fails if someone writes the cookie only when minting one (the browser
  // would drop a busy visitor's session 30 minutes after their first page),
  // or a route goes on with the page's first session once the cookie is
  // gone (a tab left open would carry a session past its end).
  it("goes on with the edge's session, writing it again on every page view for another idle timeout, and starts the next once it is gone", async () => {
    document.cookie = `agentrail_session=${SESSION}; Path=/`;
    const writes = vi.spyOn(document, 'cookie', 'set');
    try {
      const site = onPage({ behaviour: false, fingerprint: false });
      window.history.pushState(null, '', '/pricing');
      // What the browser does once the idle timeout has passed.
      document.cookie = 'agentrail_session=; Max-Age=0; Path=/';
      window.history.pushState(null, '', '/signup');
      const views = await eventsOf(site);

      const next = views[2]?.session?.id ?? '';
      expect(views.map((view) => view.session?.id)).toEqual([
        SESSION,
        SESSION,
        next,
      ]);
      expect(next).not.toBe(SESSION);
      expect(writes.mock.calls.map(([written]) => written)).toEqual([
        `agentrail_session=${SESSION}; Path=/; Max-Age=1800; SameSite=Lax`,
        `agentrail_session=${SESSION}; Path=/; Max-Age=1800; SameSite=Lax`,
        'agentrail_session=; Max-Age=0; Path=/',
        `agentrail_session=${next}; Path=/; Max-Age=1800; SameSite=Lax`,
      ]);
    } finally {
      writes.mockRestore();
    }
  });

  // Fails if someone lets a full session storage throw out of start: a site
  // whose storage is full would record nothing, and say it had started.
  it('records the page where the tab has no room to keep its id', async () => {
    const setItem = vi
      .spyOn(window.Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new DOMException(
          'The quota has been exceeded.',
          'QuotaExceededError',
        );
      });
    try {
      const site = onPage({ fingerprint: true });
      await site.agentrail.ready;
      const calls = await site.sent();

      expect(calls.flatMap((call) => call.events.map((e) => e.kind))).toEqual([
        'page.view',
      ]);
      expect(calls.flatMap((call) => call.fingerprints)).toHaveLength(1);
    } finally {
      setItem.mockRestore();
    }
  });

  // Fails if someone calls `crypto.randomUUID` anywhere a page view, a
  // route, a call, behaviour or the fingerprint takes (a page has it only
  // over HTTPS: on a plain-HTTP site the script would record nothing), or
  // reads `URLSearchParams.size`, missing before Safari 17 (a path with no
  // query would be recorded as `/pricing?`, which never equals the edge's).
  it('records a plain-HTTP page in an older browser: no crypto.randomUUID, no URLSearchParams.size', async () => {
    const randomUUID = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new TypeError('crypto.randomUUID is not a function');
    });
    const size = vi
      .spyOn(URLSearchParams.prototype, 'size', 'get')
      .mockImplementation(() => undefined as unknown as number);
    try {
      const site = onPage({ behaviour: true, fingerprint: true });
      window.history.pushState(null, '', '/pricing');
      await window.fetch('/session');
      await site.agentrail.ready;
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      const calls = await site.sent();

      expect(
        calls.flatMap((call) =>
          call.events.map((event) => [event.kind, event.http?.path]),
        ),
      ).toEqual([
        ['page.view', '/'],
        ['page.view', '/pricing'],
        ['http.client', '/session'],
      ]);
      expect(calls.flatMap((call) => call.behaviour)).toHaveLength(1);
      expect(calls.flatMap((call) => call.fingerprints)).toHaveLength(1);
    } finally {
      size.mockRestore();
      randomUUID.mockRestore();
    }
  });

  // Fails if someone lets a page start the script twice: every step would
  // be recorded twice, and the engine would see two of each.
  it('refuses to start twice on one page', () => {
    onPage({ behaviour: false, fingerprint: false });
    expect(() => start({ key: KEY, collector: COLLECTOR, window })).toThrow(
      BrowserAlreadyStartedError,
    );
  });
});

describe("the page's calls", () => {
  // Fails if someone sends a first-party call without the page's trace (the
  // server's span could not be joined to the page), sends our trace to
  // another site, leaves a call unrecorded, or records it as a span of
  // another trace than its page's: the engine would not join them.
  it("carries the page view's trace on first-party calls only, each its own span under the page's", async () => {
    const site = onPage({
      behaviour: false,
      fingerprint: false,
      firstParty: [API],
    });
    await window.fetch(`${API}/v1/projects`, { method: 'post' });
    await window.fetch('/session');
    await window.fetch('https://third-party.example.test/pixel');
    const [view, ...calls] = await eventsOf(site);
    const sentTo = (url: string) =>
      site.fetched.find((call) => call.url === url);

    expect(
      calls.map((call) => [
        call.kind,
        call.http?.method,
        call.http?.host,
        call.http?.status,
      ]),
    ).toEqual([
      ['http.client', 'POST', 'api.example.test', 200],
      ['http.client', 'GET', 'localhost:3000', 200],
    ]);
    for (const [index, url] of [`${API}/v1/projects`, '/session'].entries()) {
      const call = calls[index];
      expect(sentTo(url)?.headers.get('traceparent')).toBe(
        `00-${call?.span?.traceId ?? ''}-${call?.span?.spanId ?? ''}-01`,
      );
      expect(call?.span).toMatchObject({
        traceId: view?.span?.traceId,
        parentSpanId: view?.span?.spanId,
      });
    }
    expect(
      sentTo('https://third-party.example.test/pixel')?.headers.has(
        'traceparent',
      ),
    ).toBe(false);
  });

  // Fails if someone resolves a call's relative URL against the page's
  // address rather than its base URL: a page whose `<base>` names another
  // site would send that site our trace (a header it never allowed, so the
  // browser's preflight fails the call), and one whose base is a folder
  // would have its calls recorded on paths they never went to.
  it('resolves a relative call as the browser does, against the base URL', async () => {
    const base = document.createElement('base');
    document.head.append(base);
    try {
      await withStandInXhr(async (sent) => {
        const site = onPage({ behaviour: false, fingerprint: false });
        base.href = 'https://cdn.example.test/assets/';
        await window.fetch('manifest.json');
        const request = new window.XMLHttpRequest();
        request.open('GET', 'fonts.json');
        request.send();
        base.href = '/app/';
        await window.fetch('v1/projects');
        request.open('GET', 'v1/settings');
        request.send();
        const [, ...calls] = await eventsOf(site);

        expect(
          site.fetched
            .find((call) => call.url === 'manifest.json')
            ?.headers.has('traceparent'),
        ).toBe(false);
        expect(calls.map((call) => call.http?.path)).toEqual([
          '/app/v1/projects',
          '/app/v1/settings',
        ]);
        expect(sent.map((headers) => headers.has('traceparent'))).toEqual([
          false,
          true,
        ]);
      });
    } finally {
      base.remove();
    }
  });

  // Fails if someone reads a call's parent when it ends rather than when it
  // started: a call a single-page app's route change overtook would name a
  // parent in another trace than its own, and the engine could not join it.
  it('keeps the page a call started on as its parent, when it ends on the next', async () => {
    const site = onPage({ behaviour: false, fingerprint: false });
    const pending = window.fetch('/v1/slow');
    window.history.pushState(null, '', '/next');
    await pending;
    const [first, , call] = await eventsOf(site);

    expect(call?.kind).toBe('http.client');
    expect(call?.span).toMatchObject({
      traceId: first?.span?.traceId,
      parentSpanId: first?.span?.spanId,
    });
  });

  // Fails if someone wraps fetch but not XHR: a page on an older client
  // would carry no trace on its calls.
  it("carries the page view's trace on a first-party XHR too", async () => {
    await withStandInXhr(async (sent) => {
      const site = onPage({ behaviour: false, fingerprint: false });
      const request = new window.XMLHttpRequest();
      request.open('PUT', '/v1/settings');
      request.send('{}');
      const [view, call] = await eventsOf(site);

      expect(call).toMatchObject({
        kind: 'http.client',
        http: { method: 'PUT', path: '/v1/settings', status: 204 },
      });
      expect(call?.span?.parentSpanId).toBe(view?.span?.spanId);
      expect(sent).toEqual([
        new Map([
          [
            'traceparent',
            `00-${call?.span?.traceId ?? ''}-${call?.span?.spanId ?? ''}-01`,
          ],
        ]),
      ]);
    });
  });

  // Fails if someone gives a call that already carries a trace a second
  // one: XHR would send both values in one header, which no server reads,
  // and fetch would replace the site's own tracer's, cutting its trace.
  it("leaves a call's own traceparent as it is, and that call unrecorded", async () => {
    await withStandInXhr(async (sent) => {
      const site = onPage({ behaviour: false, fingerprint: false });
      const theirs = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      await window.fetch('/v1/init', { headers: { traceparent: theirs } });
      await window.fetch(
        new Request(new URL('/v1/request', location.href), {
          headers: { traceparent: theirs },
        }),
      );
      const request = new window.XMLHttpRequest();
      request.open('GET', '/v1/xhr');
      request.setRequestHeader('traceparent', theirs);
      request.send();
      const events = await eventsOf(site);

      expect(
        ['/v1/init', `${location.origin}/v1/request`].map((url) =>
          site.fetched
            .find((call) => call.url === url)
            ?.headers.get('traceparent'),
        ),
      ).toEqual([theirs, theirs]);
      expect(sent.map((headers) => headers.get('traceparent'))).toEqual([
        theirs,
      ]);
      expect(events.map((event) => event.kind)).toEqual(['page.view']);
    });
  });

  // Fails if someone leaves a sent XHR's listener on it: sent again, the
  // request would record its first call a second time, a new event on the
  // same span.
  it('records an XHR opened and sent again as a call of its own, once', async () => {
    await withStandInXhr(async () => {
      const site = onPage({ behaviour: false, fingerprint: false });
      const request = new window.XMLHttpRequest();
      for (const path of ['/v1/first', '/v1/second']) {
        request.open('GET', path);
        request.send();
      }
      const [, ...calls] = await eventsOf(site);

      expect(calls.map((call) => call.http?.path)).toEqual([
        '/v1/first',
        '/v1/second',
      ]);
      expect(new Set(calls.map((call) => call.span?.spanId)).size).toBe(2);
    });
  });
});

/**
 * jsdom's XHR goes to the network: a stand-in that answers at once, in
 * place of the page's XHR for `run`. It keeps the headers each send went
 * with, a header set twice as both values, as the browser sends it.
 */
async function withStandInXhr(
  run: (sent: Map<string, string>[]) => Promise<void>,
): Promise<void> {
  const sent: Map<string, string>[] = [];
  class StandInXhr extends EventTarget {
    status = 0;
    headers = new Map<string, string>();
    open(): void {
      this.headers = new Map();
    }
    setRequestHeader(name: string, value: string): void {
      const key = name.toLowerCase();
      const held = this.headers.get(key);
      this.headers.set(key, held === undefined ? value : `${held}, ${value}`);
    }
    send(): void {
      sent.push(this.headers);
      this.status = 204;
      this.dispatchEvent(new Event('loadend'));
    }
  }
  const realXhr = window.XMLHttpRequest;
  window.XMLHttpRequest = StandInXhr as unknown as typeof XMLHttpRequest;
  try {
    await run(sent);
  } finally {
    window.XMLHttpRequest = realXhr;
  }
}
