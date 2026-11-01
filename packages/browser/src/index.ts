import {
  newSpanId,
  newTraceId,
  sessionCookie,
  VERSION,
  type AgentrailEvent,
  type SpanContext,
} from 'agentrail-core';

import {
  MARKER_PARAMETER,
  browserEvent,
  markersOf,
  type Recorder,
} from './events.js';
import { traceFetch, traceXhr } from './fetch.js';
import { doneOnTab, nowOf, sessionOf, tabOf } from './session.js';
import { createTransport } from './transport.js';
import { traceTools } from './webmcp.js';
import { BROWSER_EVENT_KINDS, type Fingerprint, type Page } from './wire.js';

/**
 * The Agentrail browser script: on a customer's pages, the steps a person or
 * an agent driving a browser takes, sent to the collector with the browser
 * source's public key. The proofs come first and need no consent: the
 * session the edge set, a trace on every first-party call, the markers a
 * page was reached by, and the page's WebMCP tool calls. Behaviour (raw,
 * timing only) and the fingerprint are loaded apart, and each can be turned
 * off. Nothing is read of what is typed, pasted or chosen, nor of the DOM.
 */

export {
  BrowserCollectorRefusedError,
  BrowserCollectorUnavailableError,
} from './transport.js';
export {
  BROWSER_EVENT_KINDS,
  KEY_CLASSES,
  POINTER_TYPES,
  type BrowserCall,
  type Fingerprint,
  type FingerprintComponent,
  type Frame,
  type FrameBatch,
  type FrameType,
} from './wire.js';

/** The script was started twice on one page: the second would double every step. */
export class BrowserAlreadyStartedError extends Error {
  override readonly name = 'BrowserAlreadyStartedError';
}

export interface BrowserOptions {
  /** The browser source's public key, which writes its events and nothing else. */
  readonly key: string;
  /** The collector's `POST /ingest/browser`. */
  readonly collector: string;
  /** The service the steps are of; the page's host by default. */
  readonly service?: string;
  /** Origins besides the page's own whose calls carry the trace, as `https://api.example.com`. */
  readonly firstParty?: readonly string[];
  /** Query parameters a recorded path keeps; the rest are dropped and named. */
  readonly queryAllowlist?: readonly string[];
  /** The edge's session cookie. */
  readonly sessionCookie?: string;
  /**
   * Seconds without a request after which a visitor's session ends; 30
   * minutes by default. The edge in front of the site takes the same.
   */
  readonly sessionIdleTimeout?: number;
  /**
   * The domain a visitor's session is shared across, as `example.com`; by
   * default, the page's host. The edge in front of the site takes the same.
   */
  readonly sessionCookieDomain?: string;
  /** Raw behaviour, timing only. On unless turned off. */
  readonly behaviour?: boolean;
  /** The tab's fingerprint. On unless turned off. */
  readonly fingerprint?: boolean;
  /**
   * Told of every call the collector refused or never got, and of a part
   * that failed to load. Warned on the page's console unless given.
   */
  readonly onError?: (error: Error) => void;
  /** The page; this page's window by default. */
  readonly window?: Page;
}

export interface Agentrail {
  /** Settles once the behaviour recorder runs and the fingerprint is queued. */
  readonly ready: Promise<void>;
  /** Sends what is queued now, as a fetch. */
  flush(): void;
  /** Stops recording, restores what was wrapped, and sends what is queued. */
  stop(): void;
}

const started = new WeakSet<Page>();

/** Starts the script on a page: once a page, as early as it can load. */
export function start(options: BrowserOptions): Agentrail {
  const window = options.window ?? globalThis.window;
  // Before the page counts as started, so a start refused for its options
  // can be made again with them fixed.
  const cookie = sessionCookie({
    name: options.sessionCookie ?? 'agentrail_session',
    idleTimeout: options.sessionIdleTimeout,
    domain: options.sessionCookieDomain,
  });
  if (started.has(window))
    throw new BrowserAlreadyStartedError(
      'Agentrail is already recording this page.',
    );
  started.add(window);
  const { document, navigator } = window;
  const now = nowOf(window);
  const tab = tabOf(window);
  const recorder: Recorder = {
    allowlist: new Set([MARKER_PARAMETER, ...(options.queryAllowlist ?? [])]),
    service: options.service ?? window.location.hostname,
    tab,
    session: sessionOf(document, cookie),
    userAgent: navigator.userAgent,
  };
  const firstParty = new Set([
    window.location.origin,
    ...(options.firstParty ?? []).map((origin) => new URL(origin).origin),
  ]);

  const onError =
    options.onError ??
    ((error: Error) => {
      console.warn(`Agentrail: ${error.message}`);
    });
  // Undone on stop, in reverse.
  const undo: (() => void)[] = [];
  let stopped = false;
  let beforeSend = (): void => undefined;
  const transport = createTransport({
    endpoint: options.collector,
    key: options.key,
    tab,
    component: {
      name: 'agentrail-browser',
      version: VERSION,
      surfaces: ['browser'],
    },
    // Taken before it is wrapped: the script's own calls carry no trace.
    fetch: window.fetch.bind(window),
    beacon:
      typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : null,
    onError: (error) => {
      onError(error);
    },
    beforeSend: () => {
      beforeSend();
    },
  });
  const record = (event: AgentrailEvent) => {
    transport.event(event);
  };

  // The page view: a trace of its own, every step on the page under it.
  let page: { id: string; span: SpanContext } = { id: '', span: newSpan() };
  function newSpan(): SpanContext {
    return { traceId: newTraceId(), spanId: newSpanId() };
  }
  function viewed(): void {
    const url = new URL(window.location.href);
    const span = newSpan();
    const event = browserEvent(recorder, {
      kind: BROWSER_EVENT_KINDS.pageView,
      start: now(),
      end: null,
      span,
      parentSpanId: null,
      spanKind: 'internal',
      url,
      method: 'GET',
      status: page.id === '' ? navigationStatus(window) : null,
      seen: markersOf(url),
    });
    page = { id: event.id, span };
    record(event);
  }
  viewed();

  // A route a single-page app moves to is a page view of its own, and goes
  // on with the session, or starts the next, as a page load does; a
  // replaced entry is the same page.
  function routed(): void {
    recorder.session = sessionOf(document, cookie);
    viewed();
  }
  // Kept unbound: called again with the history it came from as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const { pushState } = window.history;
  window.history.pushState = function (
    this: History,
    ...args: Parameters<History['pushState']>
  ) {
    pushState.apply(this, args);
    routed();
  };
  const onPopState = () => {
    routed();
  };
  window.addEventListener('popstate', onPopState);
  undo.push(() => {
    window.history.pushState = pushState;
    window.removeEventListener('popstate', onPopState);
  });

  const calls = {
    recorder,
    firstParty: (url: URL) => firstParty.has(url.origin),
    page: () => page.span,
    now,
    record,
  };
  undo.push(traceFetch(window, calls), traceXhr(window, calls));
  undo.push(
    traceTools(window, { recorder, page: () => page.span, now, record }),
  );

  /** A part loaded apart that failed: told, never thrown into the page. */
  const told = (error: unknown) => {
    if (!(error instanceof Error)) throw error;
    onError(error);
  };

  const behaviourReady =
    options.behaviour === false
      ? Promise.resolve()
      : import('./behaviour.js').then(({ recordBehaviour }) => {
          // Stopped while it loaded: it never starts.
          if (stopped) return;
          const behaviour = recordBehaviour(window, {
            page: () => page.id,
            now,
            emit: (batch) => {
              transport.behaviour(batch);
            },
          });
          beforeSend = () => {
            behaviour.flush();
          };
          undo.push(() => {
            behaviour.stop();
          });
        }, told);

  const on = page.id;
  // Once a tab: the pages after the first are the same browser.
  const fingerprinted = doneOnTab(window, 'agentrail_fingerprinted');
  const fingerprintReady =
    options.fingerprint === false || fingerprinted.done
      ? Promise.resolve()
      : import('./fingerprint.js')
          // Stopped while it loaded or measured: not read, nor kept as read,
          // so the tab's next start reads it.
          .then(({ readFingerprint }) =>
            stopped ? null : readFingerprint(window),
          )
          .then((components) => {
            if (components === null || stopped) return;
            const fingerprint: Fingerprint = {
              id: crypto.randomUUID(),
              page: on,
              components,
            };
            transport.fingerprint(fingerprint);
            fingerprinted.mark();
          })
          .catch(told);

  // A page being hidden may never come back: what is queued goes as a beacon.
  const onHidden = () => {
    if (document.visibilityState === 'hidden') transport.send('beacon');
  };
  const onPageHide = () => {
    transport.send('beacon');
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', onPageHide);
  undo.push(() => {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', onPageHide);
  });

  return {
    ready: Promise.all([behaviourReady, fingerprintReady]).then(
      () => undefined,
    ),
    flush() {
      transport.send('fetch');
    },
    stop() {
      stopped = true;
      for (const restore of undo.reverse()) restore();
      undo.length = 0;
      transport.send('fetch');
      transport.stop();
      started.delete(window);
    },
  };
}

/** The status the page's own document came with, where the browser tells it. */
function navigationStatus(window: Page): number | null {
  const [entry] = window.performance.getEntriesByType('navigation');
  const status: unknown =
    entry === undefined ? undefined : Reflect.get(entry, 'responseStatus');
  return typeof status === 'number' && status > 0 ? status : null;
}
