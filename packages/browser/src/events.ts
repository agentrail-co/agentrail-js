import type { AgentrailEvent, SpanContext } from 'agentrail-core';

import { BROWSER_EVENT_KINDS } from './wire.js';

/**
 * The browser's events as the collector takes them: a page view, a
 * first-party fetch, a WebMCP tool call. Each is a span of the page view's
 * trace, so the proof layer joins a page's steps by trace, and a fetch's
 * `traceparent` joins the server's span to it.
 */

/** The query parameter the edge plants a link's marker in. */
export const MARKER_PARAMETER = 'h';

/** A path's leading marker, as the edge plants it for an API's links. */
const PATH_MARKER = /^\/h\/([0-9A-Za-z]{16}|[0-9A-Za-z]{14})(?=\/|$)/u;

/** A marker in a URL anywhere in a text, as a tool's arguments may hold one. */
const MARKER_IN_TEXT =
  /(?:[?&]h=|\/h\/)([0-9A-Za-z]{16}|[0-9A-Za-z]{14})(?![0-9A-Za-z])/gu;

export interface Recorder {
  /** The query parameters a recorded path keeps; the marker's always. */
  readonly allowlist: ReadonlySet<string>;
  readonly service: string;
  readonly tab: string;
  /** The session the last page view went on with. */
  session: string;
  readonly userAgent: string;
}

/** A path as it is recorded: the allowlisted query only. */
export function recordedPath(
  url: URL,
  allowlist: ReadonlySet<string>,
): { path: string; dropped: boolean } {
  const kept = new URLSearchParams(
    [...url.searchParams].filter(([name]) => allowlist.has(name)),
  );
  return {
    path: `${url.pathname}${kept.size === 0 ? '' : `?${kept.toString()}`}`,
    dropped: [...url.searchParams.keys()].some((name) => !allowlist.has(name)),
  };
}

/** The markers a URL carries: in the `h` parameter, or as a path prefix. */
export function markersOf(url: URL): string[] {
  const seen = url.searchParams.getAll(MARKER_PARAMETER);
  const prefix = PATH_MARKER.exec(url.pathname)?.[1];
  return prefix === undefined ? seen : [...seen, prefix];
}

/** The markers in URLs anywhere in a value, as text; the value is not kept. */
export function markersIn(value: unknown): string[] {
  // A tool given no arguments has none to read; what WebMCP hands a tool is
  // otherwise JSON.
  if (value === undefined) return [];
  const text = JSON.stringify(value);
  return [...text.matchAll(MARKER_IN_TEXT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

interface Step {
  readonly kind: (typeof BROWSER_EVENT_KINDS)[keyof typeof BROWSER_EVENT_KINDS];
  readonly start: number;
  readonly end: number | null;
  readonly span: SpanContext;
  readonly parentSpanId: string | null;
  readonly spanKind: 'internal' | 'client';
  /** The request it made or answered, with its status when known. */
  readonly url: URL | null;
  readonly method: string;
  readonly status: number | null;
  readonly seen: readonly string[];
}

export function browserEvent(recorder: Recorder, step: Step): AgentrailEvent {
  const recorded =
    step.url === null ? null : recordedPath(step.url, recorder.allowlist);
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    surface: 'browser',
    kind: step.kind,
    start: step.start,
    end: step.end,
    clock: 'browser',
    emittedBy: 'argus',
    // A tab is one clock, as an edge instance is one.
    resource: {
      serviceName: recorder.service,
      serviceInstanceId: recorder.tab,
    },
    span: {
      traceId: step.span.traceId,
      spanId: step.span.spanId,
      parentSpanId: step.parentSpanId,
      kind: step.spanKind,
      publicEntry: false,
      subtreeSpanIds: [],
      links: [],
    },
    session: { id: recorder.session, previousId: null },
    http:
      step.url === null || recorded === null
        ? null
        : {
            method: step.method,
            // With its port, as a request for it is recorded.
            host: step.url.host,
            path: recorded.path,
            status: step.status,
            location: null,
            contentType: null,
            linksOut: [],
          },
    // The page has no address of its own to hash, and the hash key never
    // goes into a page.
    actor: { egress: null, userAgent: recorder.userAgent, client: null },
    principal: null,
    registration: null,
    markers: { served: [], seen: [...step.seen] },
    redactions:
      recorded?.dropped === true
        ? [{ field: 'http.path', reason: 'query_outside_allowlist' }]
        : [],
  };
}
