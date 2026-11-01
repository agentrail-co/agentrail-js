import {
  createCollector,
  formatTraceparent,
  hashKeyIdOf,
  keyedHash,
  newSessionId,
  newSpanId,
  newTraceId,
  parseMarker,
  parseTraceparent,
  sessionCookie,
  VERSION,
  type AgentrailEvent,
  type Collector,
  type PrincipalKind,
  type SpanContext,
} from 'agentrail-core';

import { MARKER_PARAMETER, markLinks, type MarkedHosts } from './links.js';

/**
 * The edge adapter: in front of a customer's site, on the Fetch API, it
 * records every request as one event and adds what proves which requests
 * are one agent's journey (docs/research/agent-journey-correlation.md, 12):
 *
 * - a marker in every link of an agent-facing answer (Markdown, `llms.txt`),
 *   a lane per link, after the cache, so no two readers share one;
 * - a session cookie it sets itself and the browser script reads too, which
 *   ends after 30 minutes without a request, and a day after it began;
 * - a trace of its own for every request, passed to the origin in
 *   `traceparent`, with any caller's trace kept as a span link only: a public
 *   endpoint never takes its parent from outside;
 * - the client address and any verified principal, hashed with the
 *   workspace's key before anything leaves.
 *
 * The events go to the collector after the answer, through the platform's
 * `waitUntil`, so recording never slows a request. Requests one edge answers
 * share calls: what is sent while a call is out goes in the next, together,
 * so a site creates its edge once, not per request.
 */

/** A path's leading `/h/<segment>`: a link's marker, when the segment reads as one. */
const PATH_MARKER = /^\/h\/([^/]+)/u;
/** The most of an agent-facing answer read to mark its links; a larger one passes as it came. */
const MARKABLE_BYTES = 2 * 1024 * 1024;
/**
 * How long after the origin answered the call carrying a request's event may
 * run, every try and wait included. Cloudflare gives `waitUntil` 30 s after
 * the answer is sent, the least of the platforms, and cancels what is still
 * running then; counted from before it is sent, 25 s leaves room for a slow
 * `identify`.
 */
const SEND_WITHIN_MS = 25_000;

/** The site's `identify` threw: the request is recorded without a principal. */
export class IdentifyError extends Error {
  override readonly name = 'IdentifyError';
}

/**
 * What the site's own check reads of a request: never its body, which has
 * gone to the origin by the time the check runs.
 */
export type RequestHead = Pick<Request, 'method' | 'url' | 'headers'>;

/** A verified identity the site's own check found; its ids are hashed before they leave. */
export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: string;
  readonly actingUserId?: string | null;
}

export interface EdgeOptions {
  /** Where events go, and the edge source's secret. */
  readonly collector: { readonly endpoint: string; readonly secret: string };
  /** The workspace's hash key, which every component of it hashes with. */
  readonly hashKey: string;
  /** The site's own hosts, whose links an agent-facing answer marks, and how. */
  readonly hosts: MarkedHosts;
  /** Query parameters kept on a recorded path; every other is dropped. */
  readonly queryAllowlist?: readonly string[];
  /** The session cookie's name. */
  readonly sessionCookie?: string;
  /**
   * Seconds without a request after which a visitor's session ends; 30
   * minutes by default. The browser script on the same site takes the same.
   */
  readonly sessionIdleTimeout?: number;
  /**
   * The domain a visitor's session is shared across, as `example.com` for
   * `docs.example.com` and `app.example.com`; by default, the one host.
   */
  readonly sessionCookieDomain?: string;
  /**
   * The verified principal behind a request, by the site's own check of its
   * method, URL and headers. It runs after the answer.
   */
  readonly identify?: (
    request: RequestHead,
  ) => Principal | null | Promise<Principal | null>;
  /** The service the events name; the request's host by default. */
  readonly service?: string;
  /**
   * Told of events that could not be sent, and of an `identify` that threw.
   * Logs by default.
   */
  readonly onError?: (error: Error) => void;
  /** The fetch the collector's calls go through; the platform's own by default. */
  readonly fetch?: typeof fetch;
}

/** What the platform the edge runs on provides. */
export interface EdgeAdapter {
  /** The client's address, as the platform saw it; null when it says none. */
  clientAddress(request: Request): string | null;
  /** Keeps the platform running work past the answer. */
  waitUntil(work: Promise<unknown>): void;
  /** Sends the request on to the site. */
  origin(request: Request): Promise<Response>;
  /** This edge instance, when the platform names one. */
  readonly instance: string | null;
}

export interface Edge {
  /** Answers a request through the origin, and records it. */
  handle(request: Request, adapter: EdgeAdapter): Promise<Response>;
}

interface Observed {
  status: number | null;
  location: string | null;
  contentType: string | null;
  served: string | null;
  linksOut: readonly string[];
}

/**
 * The markers a query carries in `h`, and the query without them, every
 * other pair exactly as it came: a value that does not read as a marker is
 * the site's own, and stays.
 */
function markersOffQuery(search: string): { markers: string[]; rest: string } {
  const markers: string[] = [];
  const rest = search
    .slice(1)
    .split('&')
    .filter((pair) => {
      const [entry] = new URLSearchParams(pair);
      if (entry?.[0] !== MARKER_PARAMETER || !parseMarker(entry[1]).valid)
        return true;
      markers.push(entry[1]);
      return false;
    });
  return { markers, rest: rest.join('&') };
}

/**
 * An answer whose links are marked: a whole one (a `200` to a `GET`, so never
 * a range) in Markdown, or `llms.txt` or a `.md` path served as text.
 */
function isAgentFacing(method: string, url: URL, response: Response): boolean {
  if (method !== 'GET' || response.status !== 200) return false;
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (type.startsWith('text/markdown') || type.startsWith('text/x-markdown'))
    return true;
  return (
    type.startsWith('text/plain') &&
    /(?:\/llms(?:-full)?\.txt|\.md)$/u.test(url.pathname)
  );
}

/**
 * The origin's headers for a body this edge has read: a fetch hands it over
 * decoded, so neither the origin's encoding nor its length is the body's.
 */
function headersOfRead(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return headers;
}

/**
 * The answer's text, when it is at most `limit` bytes. A larger answer comes
 * back as a response that sends what was read and then the rest, as it came.
 */
async function readUpTo(
  response: Response,
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<string | Response> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > limit) {
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
        },
        async pull(controller) {
          const more = await reader.read();
          if (more.done) controller.close();
          else controller.enqueue(more.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(rest, {
        status: response.status,
        statusText: response.statusText,
        headers: headersOfRead(response),
      });
    }
  }
  return (
    chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') +
    decoder.decode()
  );
}

export function createEdge(options: EdgeOptions): Edge {
  const { hashKey, hosts, identify, service } = options;
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error('agentrail:', error);
    });
  const cookie = sessionCookie({
    name: options.sessionCookie ?? 'agentrail_session',
    idleTimeout: options.sessionIdleTimeout,
    domain: options.sessionCookieDomain,
  });
  const allowlist = new Set([
    MARKER_PARAMETER,
    ...(options.queryAllowlist ?? []),
  ]);
  // Every call names the key its events were hashed with. Its id is a
  // digest, which WebCrypto only gives asynchronously, so the collector is
  // ready from the first send on, never on a request's path.
  const collector: Promise<Collector> = hashKeyIdOf(hashKey).then((hashKeyId) =>
    createCollector({
      endpoint: options.collector.endpoint,
      secret: options.collector.secret,
      component: {
        name: 'agentrail-edge',
        version: VERSION,
        surfaces: ['edge'],
        hashKeyId,
      },
      onError,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );

  /** A path as it is recorded: the allowlisted query only. */
  function recordedPath(url: URL): { path: string; dropped: boolean } {
    const kept = new URLSearchParams(
      [...url.searchParams].filter(([name]) => allowlist.has(name)),
    );
    return {
      path: `${url.pathname}${kept.size === 0 ? '' : `?${kept.toString()}`}`,
      dropped: [...url.searchParams.keys()].some(
        (name) => !allowlist.has(name),
      ),
    };
  }

  /** A redirect's target as it is recorded: the allowlisted query only, no fragment. */
  function recordedLocation(
    location: string | null,
    base: URL,
  ): { location: string | null; redaction: string | null } {
    if (location === null) return { location: null, redaction: null };
    let target: URL;
    try {
      target = new URL(location, base);
    } catch (error) {
      // A target the edge cannot read, it cannot strip either: it stays here.
      if (error instanceof TypeError)
        return { location: null, redaction: 'unparsable' };
      throw error;
    }
    const { path, dropped } = recordedPath(target);
    return {
      location: `${target.protocol}//${target.host}${path}`,
      redaction: dropped ? 'query_outside_allowlist' : null,
    };
  }

  /**
   * The principal the site's own check names. A check that throws is the
   * site's to fix, and is told to `onError`; the request is still a step the
   * agent took, recorded without the principal the check could not name.
   */
  async function principalOf(request: RequestHead): Promise<Principal | null> {
    if (identify === undefined) return null;
    try {
      return await identify(request);
    } catch (error) {
      onError(
        new IdentifyError(
          "The site's identify threw; the request is recorded without a principal.",
          { cause: error },
        ),
      );
      return null;
    }
  }

  async function marked(
    method: string,
    url: URL,
    response: Response,
    observed: Observed,
  ): Promise<Response> {
    const length = Number(response.headers.get('content-length') ?? '0');
    if (
      !isAgentFacing(method, url, response) ||
      response.body === null ||
      length > MARKABLE_BYTES
    )
      return response;
    const text = await readUpTo(response, response.body, MARKABLE_BYTES);
    if (text instanceof Response) return text;
    const result = markLinks(text, url, hosts, (link) => {
      return `${link.host}${recordedPath(link).path}`;
    });
    observed.served = result.served;
    observed.linksOut = result.linksOut;
    const headers = headersOfRead(response);
    // The body is now this reader's alone.
    headers.delete('etag');
    if (result.served !== null)
      headers.set('cache-control', 'private, no-store');
    return new Response(result.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async function eventOf(input: {
    request: RequestHead;
    url: URL;
    address: string | null;
    instance: string | null;
    start: number;
    end: number;
    span: SpanContext;
    caller: SpanContext | null;
    session: string;
    seen: readonly string[];
    observed: Observed;
  }): Promise<AgentrailEvent> {
    const { request, url, observed } = input;
    // With its port, as a link to it is recorded.
    const host = url.host;
    const { path, dropped } = recordedPath(url);
    const location = recordedLocation(observed.location, url);
    const principal = await principalOf(request);
    const actingUserId = principal?.actingUserId ?? null;
    return {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      surface: 'edge',
      kind: 'http.request',
      start: input.start,
      end: input.end,
      clock: 'edge',
      emittedBy: 'argus',
      resource: {
        serviceName: service ?? host,
        serviceInstanceId: input.instance,
      },
      span: {
        traceId: input.span.traceId,
        spanId: input.span.spanId,
        parentSpanId: null,
        kind: 'server',
        publicEntry: true,
        subtreeSpanIds: [],
        links: input.caller === null ? [] : [input.caller],
      },
      session: { id: input.session, previousId: null },
      http: {
        method: request.method,
        host,
        path,
        status: observed.status,
        location: location.location,
        contentType: observed.contentType,
        linksOut: [...observed.linksOut],
      },
      actor: {
        egress:
          input.address === null
            ? null
            : await keyedHash(hashKey, input.address),
        userAgent: request.headers.get('user-agent'),
        client: null,
      },
      principal:
        principal === null
          ? null
          : {
              kind: principal.kind,
              id: await keyedHash(hashKey, principal.id),
              actingUserId:
                actingUserId === null
                  ? null
                  : await keyedHash(hashKey, actingUserId),
            },
      registration: null,
      markers: {
        served:
          observed.served === null
            ? []
            : [{ value: observed.served, durable: false }],
        seen: [...input.seen],
      },
      redactions: [
        ...(input.address === null
          ? []
          : [{ field: 'actor.egress', reason: 'keyed_hash' }]),
        ...(principal === null
          ? []
          : [{ field: 'principal.id', reason: 'keyed_hash' }]),
        ...(dropped
          ? [{ field: 'http.path', reason: 'query_outside_allowlist' }]
          : []),
        ...(location.redaction === null
          ? []
          : [{ field: 'http.location', reason: location.redaction }]),
      ],
    };
  }

  return {
    async handle(request, adapter) {
      const start = Date.now();
      const url = new URL(request.url);
      const query = markersOffQuery(url.search);
      const segment = PATH_MARKER.exec(url.pathname)?.[1];
      const pathMarker =
        segment !== undefined && parseMarker(segment).valid ? segment : null;
      const seen =
        pathMarker === null ? query.markers : [...query.markers, pathMarker];

      // What the origin sees: the markers taken off and nothing else of the
      // address changed, and this edge's trace.
      const originUrl = new URL(url);
      if (query.markers.length > 0) originUrl.search = query.rest;
      if (pathMarker !== null)
        originUrl.pathname =
          url.pathname.slice(`/h/${pathMarker}`.length) || '/';
      const caller = parseTraceparent(request.headers.get('traceparent'));
      const span = { traceId: newTraceId(), spanId: newSpanId() };
      const headers = new Headers(request.headers);
      headers.set('traceparent', formatTraceparent(span));
      // The caller's vendor state belongs to the caller's trace.
      headers.delete('tracestate');
      const forwarded = new Request(originUrl, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        // A visitor who goes away stops the origin's work too.
        signal: request.signal,
        // A streamed body needs it; Workers and Node both take it.
        duplex: 'half',
      } as RequestInit);

      // What `identify` reads once the answer is sent: the body is the origin's.
      const head: RequestHead = {
        method: request.method,
        url: request.url,
        headers: new Headers(request.headers),
      };
      // A session a day old starts the next, which names no previous one:
      // the engine would join the two again. One idle too long the browser
      // has already dropped.
      const session =
        cookie.read(request.headers.get('cookie') ?? '', start) ??
        newSessionId(start);
      const observed: Observed = {
        status: null,
        location: null,
        contentType: null,
        served: null,
        linksOut: [],
      };
      try {
        // Links resolve against the address the origin answered for, so a
        // relative one never carries the marker this request came with.
        const answer = await marked(
          request.method,
          originUrl,
          await adapter.origin(forwarded),
          observed,
        );
        observed.status = answer.status;
        observed.location = answer.headers.get('location');
        observed.contentType = answer.headers.get('content-type');
        // On every answer, so the session lasts another idle timeout.
        const withCookie = new Response(answer.body, answer);
        withCookie.headers.append(
          'set-cookie',
          cookie.write(session, url.protocol === 'https:'),
        );
        return withCookie;
      } finally {
        // One event per request however its answer ended: a request the
        // origin could not answer is still a step the agent took.
        const end = Date.now();
        adapter.waitUntil(
          (async () => {
            const sending = await collector;
            await sending.send(
              await eventOf({
                request: head,
                url,
                address: adapter.clientAddress(request),
                instance: adapter.instance,
                start,
                end,
                span,
                caller,
                session,
                seen,
                observed,
              }),
              end + SEND_WITHIN_MS,
            );
          })(),
        );
      }
    },
  };
}

/** Cloudflare Workers: the platform's client address, and the Worker's `waitUntil`. */
export function cloudflare(
  context: { waitUntil(work: Promise<unknown>): void },
  origin: (request: Request) => Promise<Response> = (request) => fetch(request),
): EdgeAdapter {
  return {
    clientAddress: (request) => request.headers.get('cf-connecting-ip'),
    waitUntil: (work) => {
      context.waitUntil(work);
    },
    origin,
    instance: null,
  };
}

/**
 * Vercel (Routing Middleware, `proxy.ts`): the address Vercel's edge saw,
 * and `waitUntil` from `@vercel/functions`. Middleware cannot rewrite an
 * answer it passes on, so `origin` fetches the site itself, from its own
 * origin.
 */
export function vercel(options: {
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly origin: (request: Request) => Promise<Response>;
}): EdgeAdapter {
  return {
    clientAddress: (request) =>
      request.headers.get('x-real-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      null,
    waitUntil: options.waitUntil,
    origin: options.origin,
    instance: null,
  };
}
