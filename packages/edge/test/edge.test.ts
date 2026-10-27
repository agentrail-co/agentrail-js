import {
  keyedHash,
  linkMarker,
  newMarker,
  newSpanId,
  newTraceId,
} from '@agentrail/core';
import {
  ingestEventSchema,
  link,
  linkageSettings,
  parseMarker,
  type IngestEvent,
} from '@argus/journey-linkage';
import { describe, expect, it } from 'vitest';

import {
  cloudflare,
  createEdge,
  vercel,
  type EdgeAdapter,
  type Principal,
  type RequestHead,
} from '../src/index.js';

const HASH_KEY = 'k'.repeat(64);
const ADDRESS = '203.0.113.7';
const DOCS = 'docs.example.test';
const APP = 'app.example.test';

/**
 * An edge in front of a stand-in origin, with what the origin was sent and
 * every event the collector received, each read as the collector reads it.
 */
function edgeBefore(
  origin: (request: Request) => Response | Promise<Response>,
  identify?: (request: RequestHead) => Promise<Principal | null>,
) {
  const forwarded: Request[] = [];
  const events: IngestEvent[] = [];
  const work: Promise<unknown>[] = [];
  const edge = createEdge({
    collector: {
      endpoint: 'https://collector.example.test',
      secret: 'ajs_edge',
    },
    hashKey: HASH_KEY,
    hosts: { [DOCS]: 'query', [APP]: 'path' },
    queryAllowlist: ['page'],
    ...(identify ? { identify } : {}),
    onError: (error) => {
      throw error;
    },
    fetch: (_input, init) => {
      if (typeof init?.body !== 'string') throw new TypeError('no JSON body');
      const call = JSON.parse(init.body) as { events: unknown[] };
      events.push(
        ...call.events.map((event) => ingestEventSchema.parse(event)),
      );
      return Promise.resolve(Response.json({ accepted: call.events.length }));
    },
  });
  const adapter: EdgeAdapter = {
    clientAddress: () => ADDRESS,
    waitUntil: (promise) => {
      work.push(promise);
    },
    origin: async (request) => {
      forwarded.push(request);
      return origin(request);
    },
    instance: 'edge-test',
  };
  async function send(request: Request) {
    try {
      return await edge.handle(request, adapter);
    } finally {
      // What the platform keeps running past the answer: the event's send.
      await Promise.all(work.splice(0));
    }
  }
  return { send, forwarded, events };
}

const MARKDOWN = [
  '# Start here',
  '[Quickstart](/guide/quickstart.md#install), then https://docs.example.test/api.md.',
  '[Quickstart again](https://docs.example.test/guide/quickstart.md#usage)',
  '[The app](https://app.example.test/)',
  '[Agents](https://docs.example.test/wiki/Agent_(software).md) and https://docs.example.test/wiki/Agent_(software).md',
  '[Deeper](https://docs.example.test/a_((b))/c.md) and https://docs.example.test/a_((b))/c.md',
  '[Elsewhere](https://elsewhere.example.test/x) and [this page](#top)',
  '[Bracketed](</guide/quick start.md>) and [bracketed](<https://docs.example.test/api.md>)',
  '[A host by any name](https://constructor/x)',
].join('\n');

describe('the edge', () => {
  // Fails if someone passes the caller's traceparent on as our parent (a
  // public endpoint's caller could then name any trace), lets the origin see
  // the markers it takes off, resolves the answer's links against the
  // marked address (each would carry the old marker inside the new), or
  // records a host without the port its links keep.
  it('sends a request to its origin without its markers, under a trace of its own that links the caller', async () => {
    const { send, forwarded, events } = edgeBefore(
      () =>
        new Response('[Next](next)', {
          headers: { 'content-type': 'text/markdown' },
        }),
    );
    const caller = { traceId: newTraceId(), spanId: newSpanId() };
    const query = newMarker();
    const lane = linkMarker(newMarker(), 3);
    const site = `${APP}:8443`;
    const page = await send(
      new Request(
        `https://${site}/h/${lane}/items/projects?h=${query}&page=2&token=x`,
        {
          headers: {
            traceparent: `00-${caller.traceId}-${caller.spanId}-01`,
            tracestate: 'vendor=caller',
          },
        },
      ),
    );

    const [sent] = forwarded;
    const [event] = events;
    if (sent === undefined || event?.span == null)
      throw new Error('nothing sent');
    expect(sent.url).toBe(`https://${site}/items/projects?page=2&token=x`);
    expect(sent.headers.get('traceparent')).toBe(
      `00-${event.span.traceId}-${event.span.spanId}-01`,
    );
    expect(event.span.traceId).not.toBe(caller.traceId);
    expect(sent.headers.get('tracestate')).toBeNull();
    expect(event.span).toMatchObject({
      parentSpanId: null,
      publicEntry: true,
      links: [caller],
    });
    expect(event.markers.seen).toEqual([query, lane]);
    expect(event.http).toMatchObject({
      host: site,
      path: `/h/${lane}/items/projects?h=${query}&page=2`,
      status: 200,
    });
    expect(event.redactions).toContainEqual({
      field: 'http.path',
      reason: 'query_outside_allowlist',
    });

    // The answer's relative link, marked once, is recorded as a request for
    // it is: the engine joins the two by that equality.
    const next = `${site}/h/${linkMarker(event.markers.served[0]?.value ?? '', 0)}/items/next`;
    expect(await page.text()).toBe(`[Next](https://${next})`);
    expect(event.http?.linksOut).toEqual([next]);
    await send(new Request(`https://${next}`));
    const followed = events[1]?.http;
    expect(`${followed?.host ?? ''}${followed?.path ?? ''}`).toBe(next);
  });

  // Fails if someone records a link in another form than a request for it
  // is recorded in, or stops marking lane by lane: the engine would never
  // join the page to the step that followed it. Fails too if a section link
  // takes another section's fragment, or a link is cut at a parenthesis of
  // its own, or marked part-way when its parentheses nest deeper than the
  // pattern reads, or a destination in angle brackets is resolved with its
  // brackets: the agent would be sent somewhere else. Fails too if a host
  // is looked up past the site's own entries (`constructor` is on every
  // object): another site's link would be marked and recorded as ours.
  it("marks an agent-facing answer's links to the site, a lane each, which the engine joins to the request that follows one", async () => {
    const { send, events } = edgeBefore(
      () =>
        new Response(MARKDOWN, {
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            etag: '"v1"',
          },
        }),
    );
    const page = await send(new Request(`https://${DOCS}/start.md`));
    const body = await page.text();
    const [served] = events;
    const marker = served?.markers.served[0]?.value;
    if (served?.http == null || marker === undefined)
      throw new Error('no marker served');

    const lane = (index: number) => linkMarker(marker, index);
    const lanes = [0, 1, 2, 3].map(lane);
    const agents = `${DOCS}/wiki/Agent_(software).md?h=${lane(3)}`;
    expect(body).toBe(
      [
        '# Start here',
        `[Quickstart](https://${DOCS}/guide/quickstart.md?h=${lane(0)}#install), then https://${DOCS}/api.md?h=${lane(1)}.`,
        `[Quickstart again](https://${DOCS}/guide/quickstart.md?h=${lane(0)}#usage)`,
        `[The app](https://${APP}/h/${lane(2)})`,
        `[Agents](https://${agents}) and https://${agents}`,
        '[Deeper](https://docs.example.test/a_((b))/c.md) and https://docs.example.test/a_((b))/c.md',
        '[Elsewhere](https://elsewhere.example.test/x) and [this page](#top)',
        `[Bracketed](</guide/quick start.md>) and [bracketed](<https://${DOCS}/api.md?h=${lane(1)}>)`,
        '[A host by any name](https://constructor/x)',
      ].join('\n'),
    );
    expect(page.headers.get('cache-control')).toBe('private, no-store');
    expect(page.headers.get('etag')).toBeNull();
    expect(served.http.linksOut).toEqual([
      `${DOCS}/guide/quickstart.md?h=${lane(0)}`,
      `${DOCS}/api.md?h=${lane(1)}`,
      `${APP}/h/${lane(2)}`,
      agents,
    ]);
    expect(lanes.map((lane) => parseMarker(lane))).toEqual(
      [0, 1, 2, 3].map((index) => ({
        valid: true,
        base: marker.slice(0, 13),
        link: index,
      })),
    );

    // The agent follows the first link, from another session and address.
    await send(new Request(`https://${DOCS}/guide/quickstart.md?h=${lane(0)}`));
    const tenant = 'workspace-1';
    const stamped = events.map((event) => ({
      ...event,
      tenant,
      observedAt: 0,
    }));
    const linkage = link({ tenant, events: stamped }, linkageSettings);
    expect(linkage.journeys).toHaveLength(1);
    expect(linkage.links).toContainEqual(
      expect.objectContaining({ rule: 'marker', status: 'active' }),
    );
  });

  // Fails if someone forwards a request without the visitor's signal: a
  // visitor who went away would leave the origin working on an answer
  // nobody reads.
  it('tells the origin when the visitor goes away', async () => {
    const visitor = new AbortController();
    const { send, forwarded } = edgeBefore(() => new Response('ok'));
    await send(
      new Request(`https://${DOCS}/start`, { signal: visitor.signal }),
    );
    visitor.abort();

    expect(forwarded[0]?.signal.aborted).toBe(true);
  });

  // Fails if someone reads and rewrites every answer (a page for people
  // would be changed), drops the size bound (an answer of any size would be
  // held in memory before the visitor got a byte), or marks a range or a
  // bodyless answer (a range's bytes would no longer be its range; a 204
  // cannot be given a body at all).
  it('passes an answer it does not mark as it came', async () => {
    const link = 'https://docs.example.test/start.md';
    const markdown = { 'content-type': 'text/markdown' };
    const answers: [string, () => Response][] = [
      [
        'a page for people',
        () =>
          new Response(`<a href="${link}">Start</a>`, {
            headers: { 'content-type': 'text/html' },
          }),
      ],
      [
        'Markdown past the size bound, with no length given',
        () =>
          new Response(`[Start](${link})\n${'x'.repeat(2 * 1024 * 1024)}`, {
            headers: markdown,
          }),
      ],
      [
        'a range of a Markdown page',
        () =>
          new Response(`[Start](${link})`, {
            status: 206,
            headers: { ...markdown, 'content-range': 'bytes 0-36/100' },
          }),
      ],
      [
        'no content',
        () => new Response(null, { status: 204, headers: markdown }),
      ],
    ];
    for (const [answer, origin] of answers) {
      const { send, events } = edgeBefore(origin);
      const page = await send(new Request(`https://${DOCS}/start.md`));
      expect(await page.text(), answer).toBe(await origin().text());
      expect(page.status, answer).toBe(origin().status);
      expect(page.headers.get('cache-control'), answer).toBeNull();
      expect(events[0]?.markers.served, answer).toEqual([]);
    }
  });

  // Fails if someone sends Markdown read past the size bound on with the
  // origin's encoding and length: a fetch hands the body over decoded, and
  // smaller-looking than it is when compressed, so the visitor would be told
  // to decompress plain text, and to expect the compressed length.
  it('sends Markdown read past the size bound as the fetch decoded it', async () => {
    const markdown = `[Start](https://${DOCS}/start.md)\n${'x'.repeat(2 * 1024 * 1024)}`;
    const { send } = edgeBefore(
      () =>
        new Response(markdown, {
          headers: {
            'content-type': 'text/markdown',
            'content-encoding': 'gzip',
            'content-length': '4096',
          },
        }),
    );
    const page = await send(new Request(`https://${DOCS}/start.md`));

    expect(page.headers.get('content-encoding')).toBeNull();
    expect(page.headers.get('content-length')).toBeNull();
    expect(page.headers.get('content-type')).toBe('text/markdown');
    expect(await page.text()).toBe(markdown);
  });

  // Fails if someone marks the cookie HttpOnly (the browser script reads
  // it), or keeps a session id the edge could not have minted.
  it('sets a session cookie it minted once, keeps it, and replaces one it could not have set', async () => {
    const { send, events } = edgeBefore(() => new Response('ok'));
    const first = await send(new Request(`https://${DOCS}/`));
    const cookie = first.headers.get('set-cookie');
    const session = events[0]?.session?.id;
    expect(cookie).toBe(
      `agentrail_session=${session ?? ''}; Path=/; SameSite=Lax; Secure`,
    );

    const again = await send(
      new Request(`https://${DOCS}/next`, {
        headers: { cookie: `other=1; agentrail_session=${session ?? ''}` },
      }),
    );
    expect(again.headers.get('set-cookie')).toBeNull();
    const forged = await send(
      new Request(`https://${DOCS}/`, {
        headers: { cookie: 'agentrail_session=chosen-by-me' },
      }),
    );
    expect(forged.headers.get('set-cookie')).not.toBeNull();
    expect(events.map((event) => event.session?.id)).toEqual([
      session,
      session,
      events[2]?.session?.id,
    ]);
    expect(events[2]?.session?.id).not.toBe(session);
  });

  // Fails if someone sends an address or a principal's id as it is: they
  // must leave the customer only as the workspace's keyed hash. (The site's
  // check reads only the request's head, so the body the origin read is
  // out of its reach by type.)
  it('hashes the client address and the verified principal with the workspace key', async () => {
    const { send, events } = edgeBefore(
      async (request) => new Response(await request.text()),
      (request) =>
        Promise.resolve(
          request.headers.get('authorization') === 'Bearer t'
            ? { kind: 'user', id: 'user-1', actingUserId: 'user-2' }
            : null,
        ),
    );
    await send(
      new Request(`https://${APP}/users/me`, {
        method: 'POST',
        headers: { authorization: 'Bearer t' },
        body: 'name=Ada',
      }),
    );
    const [event] = events;
    expect(event?.actor.egress).toBe(await keyedHash(HASH_KEY, ADDRESS));
    expect(event?.principal).toEqual({
      kind: 'user',
      id: await keyedHash(HASH_KEY, 'user-1'),
      actingUserId: await keyedHash(HASH_KEY, 'user-2'),
    });
    expect(event?.redactions).toEqual([
      { field: 'actor.egress', reason: 'keyed_hash' },
      { field: 'principal.id', reason: 'keyed_hash' },
    ]);
  });

  // Fails if someone records a redirect's target as the origin wrote it: a
  // code or a token in its query would leave the site, which the allowlist
  // exists to stop.
  it("records a redirect's target with the allowlisted query only, and redirects the visitor as the origin said", async () => {
    const target = '/callback?code=secret&state=s1&page=2#done';
    const { send, events } = edgeBefore(
      () => new Response(null, { status: 302, headers: { location: target } }),
    );
    const answer = await send(new Request(`https://${APP}/login`));
    expect(answer.headers.get('location')).toBe(target);
    expect(events[0]?.http?.location).toBe(`https://${APP}/callback?page=2`);
    expect(events[0]?.redactions).toContainEqual({
      field: 'http.location',
      reason: 'query_outside_allowlist',
    });
  });

  // Fails if someone records only answered requests, or swallows the
  // origin's failure: the platform must answer it as the failure it was.
  it('records a request the origin failed to answer, and lets the failure through', async () => {
    const failure = new TypeError('origin unreachable');
    const { send, events } = edgeBefore(() => Promise.reject(failure));
    await expect(send(new Request(`https://${APP}/items`))).rejects.toBe(
      failure,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.http?.status).toBeNull();
  });
});

describe('the platform adapters', () => {
  // Fails if someone reads an address the client writes itself where the
  // platform states the real one.
  it("take the client's address from where each platform puts it, and its waitUntil", () => {
    const kept: Promise<unknown>[] = [];
    const worker = cloudflare({ waitUntil: (work) => kept.push(work) });
    const request = new Request('https://example.test/', {
      headers: {
        'cf-connecting-ip': '198.51.100.1',
        'x-forwarded-for': '10.0.0.1',
        'x-real-ip': '192.0.2.9',
      },
    });
    expect(worker.clientAddress(request)).toBe('198.51.100.1');
    const work = Promise.resolve();
    worker.waitUntil(work);
    expect(kept).toEqual([work]);

    const origin = () => Promise.resolve(new Response('ok'));
    const proxy = vercel({ waitUntil: () => undefined, origin });
    expect(proxy.clientAddress(request)).toBe('192.0.2.9');
    expect(
      proxy.clientAddress(
        new Request('https://example.test/', {
          headers: { 'x-forwarded-for': '192.0.2.10, 10.0.0.1' },
        }),
      ),
    ).toBe('192.0.2.10');
  });
});
