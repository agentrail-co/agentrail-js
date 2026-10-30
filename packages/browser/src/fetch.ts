import {
  formatTraceparent,
  newSpanId,
  type SpanContext,
} from '@agentrail/core';

import { browserEvent, markersOf, type Recorder } from './events.js';
import type { AgentrailEvent } from '@agentrail/core';
import { BROWSER_EVENT_KINDS, type Page } from './wire.js';

/**
 * The page's first-party calls carry the page view's trace: each fetch and
 * XHR to the page's own origin, or an origin the site names, gets a
 * `traceparent` naming a span of its own under the page view's, and is
 * recorded as that span. The server's span then takes it as its parent, a
 * trace proof from the page to the backend. A call to anywhere else goes as
 * it was made, unrecorded. A relative URL is the document's base URL's, as
 * the browser resolves it: a `<base>` elsewhere sends the call elsewhere.
 *
 * A call that already carries a `traceparent` (the site's own tracer, or
 * the site's code) keeps it, and goes unrecorded: its span is not ours to
 * claim, and a second header would make the pair unreadable.
 */

export interface CallContext {
  readonly recorder: Recorder;
  /** Whether a call to this URL is the site's own. */
  readonly firstParty: (url: URL) => boolean;
  /** The page view's span: a call's parent. */
  readonly page: () => SpanContext;
  readonly now: () => number;
  readonly record: (event: AgentrailEvent) => void;
}

/** A call as it started: the page it started on is its parent, whatever page ends it. */
interface Call {
  readonly url: URL;
  readonly method: string;
  readonly span: SpanContext;
  readonly parentSpanId: string;
  readonly start: number;
}

/** A span of its own under the page view's, which is its parent. */
function spansOf(context: CallContext): Pick<Call, 'span' | 'parentSpanId'> {
  const page = context.page();
  return {
    span: { traceId: page.traceId, spanId: newSpanId() },
    parentSpanId: page.spanId,
  };
}

function callEvent(
  context: CallContext,
  call: Call,
  status: number | null,
): AgentrailEvent {
  return browserEvent(context.recorder, {
    kind: BROWSER_EVENT_KINDS.fetch,
    start: call.start,
    end: context.now(),
    span: call.span,
    parentSpanId: call.parentSpanId,
    spanKind: 'client',
    url: call.url,
    method: call.method,
    status,
    seen: markersOf(call.url),
  });
}

/** Wraps `window.fetch`; returns what restores it. */
export function traceFetch(window: Page, context: CallContext): () => void {
  // Kept unbound, to restore exactly; every call gives it the window.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = window.fetch;
  const traced: typeof fetch = async (input, init) => {
    const target =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const url = new URL(target, window.document.baseURI);
    if (!context.firstParty(url)) return original.call(window, input, init);
    // The headers the call goes with: the init's replace the request's.
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (headers.has('traceparent')) return original.call(window, input, init);
    const spans = spansOf(context);
    headers.set('traceparent', formatTraceparent(spans.span));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const call: Call = { url, method, ...spans, start: context.now() };
    try {
      const response = await original.call(window, input, { ...init, headers });
      context.record(callEvent(context, call, response.status));
      return response;
    } catch (error) {
      // Recorded as it ended, with no answer; the page sees the failure as
      // it would have.
      context.record(callEvent(context, call, null));
      throw error;
    }
  };
  window.fetch = traced;
  return () => {
    if (window.fetch === traced) window.fetch = original;
  };
}

/**
 * Wraps `XMLHttpRequest`'s `open`, `setRequestHeader` and `send`; returns
 * what restores them. A header set twice is sent as both values, so a
 * request the site gave its own `traceparent` is left as it is.
 */
export function traceXhr(window: Page, context: CallContext): () => void {
  const prototype = window.XMLHttpRequest.prototype;
  // Kept unbound: each is called again with its own request as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { open, send, setRequestHeader } = prototype;
  const calls = new WeakMap<XMLHttpRequest, Call>();
  prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: [
      async?: boolean,
      username?: string | null,
      password?: string | null,
    ]
  ) {
    const target = new URL(url, window.document.baseURI);
    if (context.firstParty(target))
      calls.set(this, {
        url: target,
        method: method.toUpperCase(),
        ...spansOf(context),
        start: 0,
      });
    else calls.delete(this);
    // Passed on as given: an open with only a method and a URL stays
    // asynchronous, as it always was.
    Reflect.apply(open, this, [method, url, ...rest]);
  };
  prototype.setRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ) {
    setRequestHeader.call(this, name, value);
    if (name.toLowerCase() === 'traceparent') calls.delete(this);
  };
  prototype.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const call = calls.get(this);
    if (call !== undefined) {
      setRequestHeader.call(this, 'traceparent', formatTraceparent(call.span));
      const started = { ...call, start: context.now() };
      // Once: a request opened and sent again is a call of its own, with a
      // span of its own.
      this.addEventListener(
        'loadend',
        () => {
          context.record(
            callEvent(context, started, this.status === 0 ? null : this.status),
          );
        },
        { once: true },
      );
    }
    send.call(this, body);
  };
  return () => {
    prototype.open = open;
    prototype.setRequestHeader = setRequestHeader;
    prototype.send = send;
  };
}
