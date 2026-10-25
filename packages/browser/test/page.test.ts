import { linkMarker, newMarker } from '@agentrail/core';
import {
  ingestEventSchema,
  link,
  linkageSettings,
} from '@argus/journey-linkage';
import { describe, expect, it } from 'vitest';

import { BrowserAlreadyStartedError, start } from '../src/index.js';
import { API, COLLECTOR, KEY, onPage } from './support/page.js';

const SESSION = '2f1d1c3e-8a4b-4c5d-9e6f-0a1b2c3d4e5f';

/** The events the collector got, each read with the engine's own schema. */
async function eventsOf(site: ReturnType<typeof onPage>) {
  return (await site.sent()).flatMap((call) =>
    call.events.map((event) => ingestEventSchema.parse(event)),
  );
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
      component: { name: '@agentrail/browser', surfaces: ['browser'] },
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
  it("carries the page view's trace on first-party calls only, each its own span the engine joins to the page", async () => {
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
    const tenant = 'workspace-1';
    const linkage = link(
      {
        tenant,
        events: [view, ...calls].flatMap((event) =>
          event === undefined ? [] : [{ ...event, tenant, observedAt: 0 }],
        ),
      },
      linkageSettings,
    );
    expect(linkage.journeys).toHaveLength(1);
  });

  // Fails if someone wraps fetch but not XHR: a page on an older client
  // would carry no trace on its calls.
  it("carries the page view's trace on a first-party XHR too", async () => {
    const headers: [string, string][] = [];
    // jsdom's XHR goes to the network: a stand-in that answers at once.
    class StandInXhr extends EventTarget {
      status = 0;
      open(): void {
        return undefined;
      }
      setRequestHeader(name: string, value: string): void {
        headers.push([name, value]);
      }
      send(): void {
        this.status = 204;
        this.dispatchEvent(new Event('loadend'));
      }
    }
    const realXhr = window.XMLHttpRequest;
    window.XMLHttpRequest = StandInXhr as unknown as typeof XMLHttpRequest;
    try {
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
      expect(headers).toEqual([
        [
          'traceparent',
          `00-${call?.span?.traceId ?? ''}-${call?.span?.spanId ?? ''}-01`,
        ],
      ]);
    } finally {
      window.XMLHttpRequest = realXhr;
    }
  });
});
