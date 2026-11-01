import { linkMarker, newMarker } from 'agentrail-core';
import { describe, expect, it, vi } from 'vitest';

import { BrowserAlreadyStartedError, start } from '../src/index.js';
import { API, COLLECTOR, KEY, onPage } from './support/page.js';

const SESSION = '2f1d1c3e-8a4b-4c5d-9e6f-0a1b2c3d4e5f';

/** The events the collector got. */
async function eventsOf(site: ReturnType<typeof onPage>) {
  return (await site.sent()).flatMap((call) => call.events);
}

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
  // keeps a cookie the edge could not have set, or mints a tab per page (a
  // reload would be another clock).
  it('mints the session as the edge does when there is none, replaces one the edge could not have set, and keeps the tab across a reload', async () => {
    document.cookie = 'agentrail_session=forged; Path=/';
    const first = onPage({ behaviour: false, fingerprint: false });
    const [before] = await eventsOf(first);
    first.agentrail.stop();
    const second = onPage({ behaviour: false, fingerprint: false });
    const [after] = await eventsOf(second);

    expect(before?.session?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(document.cookie).toContain(
      `agentrail_session=${before?.session?.id ?? ''}`,
    );
    expect(after?.session?.id).toBe(before?.session?.id);
    expect(after?.resource.serviceInstanceId).toBe(
      before?.resource.serviceInstanceId,
    );
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
      const site = onPage({ behaviour: false });
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
