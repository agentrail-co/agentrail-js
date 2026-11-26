import { createHmac, timingSafeEqual } from 'node:crypto';
import diagnostics from 'node:diagnostics_channel';
import { errorMonitor, type EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { urlToHttpOptions } from 'node:url';
import forwardedParse from 'forwarded-parse';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Attributes, Context, Span, Tracer } from '@opentelemetry/api';
import { hrTime } from '@opentelemetry/core';
import {
  CLI_HEADER,
  encodeTraceHandoff,
  readTraceHandoff,
  TRACE_HANDOFF_HEADER,
  parseTraceparent,
} from 'agentrail-core';
import { cliAttributesOf } from './cli.js';
import { ours } from './context.js';
import { isCaptureSuppressed } from './suppression.js';
import { CaptureError } from './options.js';
import type { Runtime, State } from './runtime.js';

/**
 * What a managed request never sends on as the server received it: the
 * signed handoff, which binds one call, and a CLI's `x-agentrail-cli`, which
 * names the CLI's run and session to this server alone. The application's
 * own trace headers (traceparent, tracestate, baggage, sentry-trace,
 * x-datadog-*) belong to its tracer and go on untouched.
 */
const ownHeaders = [TRACE_HANDOFF_HEADER, CLI_HEADER];
/**
 * An allowed origin gets the SDK's signed traceparent in place of the
 * application's, without the tracestate that belonged to theirs.
 */
const signedHeaders = ['traceparent', 'tracestate', TRACE_HANDOFF_HEADER];
interface Rewrite {
  readonly remove: readonly string[];
  readonly set: Readonly<Record<string, string>>;
}
/** The request undici publishes on its diagnostics channels (5, 6 and 7). */
interface UndiciRequest {
  readonly origin: string;
  readonly method: string;
  readonly path: string;
  headers: string | (string | string[])[];
  addHeader(name: string, value: string): UndiciRequest;
}
type Request = (this: unknown, ...args: unknown[]) => http.ClientRequest;
interface Call {
  readonly span: Span;
  ended: boolean;
}
const KNOWN_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'DELETE',
  'CONNECT',
  'OPTIONS',
  'TRACE',
  'PATCH',
  'QUERY',
]);
function method(input: string | undefined): string {
  if (input === undefined) return 'GET';
  const upper = input.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : '_OTHER';
}
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
function failed(span: Span, error: Error): void {
  span.setAttribute('error.type', error.name);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  span.recordException(error);
}
/** A property's value where it is a plain one, never a getter's. */
function dataProperty(target: object | undefined, name: string): unknown {
  let at: object | null | undefined = target;
  while (at !== undefined && at !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(at, name);
    if (descriptor !== undefined)
      return 'value' in descriptor ? descriptor.value : undefined;
    at = Object.getPrototypeOf(at) as object | null;
  }
  return undefined;
}
/** Node's own test for a URL argument (`internal/url` isURL). */
function isUrl(input: unknown): input is URL {
  if (typeof input !== 'object' || input === null) return false;
  const url = input as Partial<
    Record<'href' | 'protocol' | 'auth' | 'path', unknown>
  >;
  return (
    Boolean(url.href) &&
    Boolean(url.protocol) &&
    url.auth === undefined &&
    url.path === undefined
  );
}
/** The options `http.request` and `https.request` build from their arguments, as Node merges them. */
function requestOptions(args: readonly unknown[]): http.RequestOptions {
  const [first, second] = args;
  let input: http.RequestOptions | undefined;
  let options: unknown = second;
  if (typeof first === 'string') input = urlToHttpOptions(new URL(first));
  else if (isUrl(first)) input = urlToHttpOptions(first);
  else options = first;
  return typeof options === 'function'
    ? (input ?? {})
    : { ...input, ...(options as http.RequestOptions | undefined) };
}
/**
 * The arguments without this SDK's own headers, for a request whose headers
 * Node writes before `http.request` returns (an array of them, or an
 * `Expect` header): what is left of them cannot be changed afterwards.
 */
function withoutOwnHeaders(args: readonly unknown[]): readonly unknown[] {
  const index = args.findIndex(
    (arg) => typeof arg === 'object' && arg !== null && !isUrl(arg),
  );
  const options = args[index] as http.RequestOptions | undefined;
  const headers: unknown = options?.headers;
  const own = (name: unknown) =>
    typeof name === 'string' && ownHeaders.includes(name.toLowerCase());
  let kept: unknown;
  if (Array.isArray(headers)) {
    const pairs: unknown[] = [];
    for (let i = 0; i < headers.length; i += 2)
      if (!own(headers[i])) pairs.push(headers[i], headers[i + 1]);
    if (pairs.length === headers.length) return args;
    kept = pairs;
  } else if (typeof headers === 'object' && headers !== null) {
    const entries = Object.entries(headers).filter(([name]) => !own(name));
    if (entries.length === Object.keys(headers).length) return args;
    kept = Object.fromEntries(entries);
  } else return args;
  const copy = [...args];
  copy[index] = { ...options, headers: kept };
  return copy;
}
/**
 * The host and port a request names for itself, by the rules of
 * `@opentelemetry/instrumentation-http` 0.221.0, so its exported URL stays
 * what it was: `Forwarded`, then `X-Forwarded-Host`, then `Host`.
 */
function hostOf(
  header: string,
  proto: string | undefined,
): { host: string; port?: string } {
  const parts = header.split(':');
  const [first = '', second = ''] = parts;
  const defaultPort =
    proto === 'http' ? '80' : proto === 'https' ? '443' : undefined;
  if (parts.length === 1)
    return defaultPort === undefined
      ? { host: first }
      : { host: first, port: defaultPort };
  if (parts.length === 2) return { host: first, port: second };
  if (first.startsWith('[')) {
    if (parts.at(-1)?.endsWith(']')) {
      if (defaultPort !== undefined) return { host: header, port: defaultPort };
    } else if (parts.at(-2)?.endsWith(']'))
      return { host: parts.slice(0, -1).join(':'), port: parts.at(-1) ?? '' };
  }
  return { host: header };
}
function forwardedEntries(header: string): Record<string, string>[] {
  try {
    return forwardedParse(header);
  } catch (error) {
    if (error instanceof Error && error.name === 'ParseError') return [];
    throw error;
  }
}
function serverAddress(
  request: http.IncomingMessage,
  scheme: 'http' | 'https',
): { host: string; port?: string } | undefined {
  const { forwarded } = request.headers;
  if (typeof forwarded === 'string' && forwarded !== '')
    for (const entry of forwardedEntries(forwarded))
      if (entry.host) return hostOf(entry.host, entry.proto);
  const forwardedHost = request.headers['x-forwarded-host'];
  const forwardedProto = request.headers['x-forwarded-proto'];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;
  // An empty first value counts as none; an empty header still counts.
  const named = Array.isArray(forwardedHost)
    ? (forwardedHost[0] ?? '') || undefined
    : forwardedHost;
  if (named !== undefined) return hostOf(named, proto);
  const { host } = request.headers;
  return host ? hostOf(host, scheme) : undefined;
}
function incomingAttributes(
  request: http.IncomingMessage,
  scheme: 'http' | 'https',
): Attributes {
  const attributes: Attributes = {
    'http.request.method': method(request.method),
    'url.scheme': scheme,
  };
  const address = serverAddress(request, scheme);
  if (address !== undefined) {
    attributes['server.address'] = address.host;
    if (address.port !== undefined)
      attributes['server.port'] = Number(address.port);
  }
  const base = `${scheme}://${(request.headers.host ?? '') || 'localhost'}`;
  if (URL.canParse(request.url ?? '/', base)) {
    const url = new URL(request.url ?? '/', base);
    attributes['url.path'] = url.pathname;
    if (url.search) attributes['url.query'] = url.search.slice(1);
  }
  const userAgent = request.headers['user-agent'];
  if (userAgent !== undefined) attributes['user_agent.original'] = userAgent;
  return attributes;
}
function undiciUserAgent(request: UndiciRequest): string | undefined {
  let found: string | undefined;
  if (typeof request.headers === 'string') {
    for (const line of request.headers.split('\r\n'))
      if (line.slice(0, line.indexOf(':')).toLowerCase() === 'user-agent')
        found = line.slice(line.indexOf(':') + 1).trim();
    return found;
  }
  for (let i = 0; i < request.headers.length; i += 2) {
    const name = request.headers[i];
    const value = request.headers[i + 1];
    if (typeof name === 'string' && name.toLowerCase() === 'user-agent')
      found = Array.isArray(value) ? value.at(-1) : value;
  }
  return found;
}
function stripUndiciHeaders(
  request: UndiciRequest,
  names: readonly string[],
): void {
  if (typeof request.headers === 'string')
    request.headers = request.headers
      .split('\r\n')
      .filter(
        (line) =>
          !names.includes(line.slice(0, line.indexOf(':')).toLowerCase()),
      )
      .join('\r\n');
  else {
    const headers: (string | string[])[] = [];
    for (let i = 0; i < request.headers.length; i += 2) {
      const name = request.headers[i];
      const value = request.headers[i + 1];
      if (
        typeof name === 'string' &&
        value !== undefined &&
        !names.includes(name.toLowerCase())
      )
        headers.push(name, value);
    }
    request.headers = headers;
  }
}
/** Every request runs its listeners in the SDK's context: Node 24 would run a body's `data` and `end` in the connection's. */
function bind(emitter: EventEmitter, ctx: Context): void {
  const emit = emitter.emit.bind(emitter);
  emitter.emit = (event: string | symbol, ...args: unknown[]) =>
    ours.with(ctx, () => emit(event, ...args));
}

/**
 * Records the requests a server answers and the HTTP and `fetch` calls it
 * makes while answering them, beside whatever else traces the process:
 * Node's diagnostics channels for incoming requests and undici, and small
 * wrappers on `http.request`, `https.request`, `http.get` and `https.get`,
 * the only place an outbound call's port can be read before it is sent.
 * `server.emit` is never wrapped (Sentry re-wraps any emit it does not own).
 * Returns what undoes it.
 */
export function installHttpCapture(
  runtime: Runtime,
  tracer: Tracer,
): () => void {
  const collector = new URL(runtime.options.endpoint);
  const collectorPort = Number(
    collector.port || (collector.protocol === 'https:' ? 443 : 80),
  );
  const fetches = new WeakMap<object, Span>();
  const calls = new WeakMap<object, Call>();
  let installed = true;
  /** While a wrapper is building its call: that ClientRequest is the wrapper's. */
  let building = 0;

  /** A capture failure reaches `onError`, never the application's request. */
  function guard(run: () => void): void {
    try {
      run();
    } catch (error) {
      runtime.options.report(
        new CaptureError(
          'capture_failed',
          'traces',
          1,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
  }
  /** The SDK's context for a call made while it handles a request. */
  function managed(): Context | undefined {
    const ctx = ours.active();
    if (runtime.state(ctx) === undefined || isCaptureSuppressed(ctx))
      return undefined;
    const span = trace.getSpan(ctx);
    return span !== undefined && trace.isSpanContextValid(span.spanContext())
      ? ctx
      : undefined;
  }
  function rewrite(
    span: Span,
    verb: string,
    target: string,
    origin: string | undefined,
  ): Rewrite {
    if (
      origin === undefined ||
      !runtime.spans.has(span) ||
      !runtime.options.origins.has(origin)
    )
      return { remove: ownHeaders, set: {} };
    const sc = span.spanContext();
    const traceparent = `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, '0')}`;
    const encoded = encodeTraceHandoff({
      traceparent,
      hashKeyId: runtime.keyId,
      issuedAt: Date.now(),
      method: verb,
      target,
    });
    return {
      remove: [...ownHeaders, ...signedHeaders],
      set: {
        traceparent,
        [TRACE_HANDOFF_HEADER]:
          encoded.tokenPrefix +
          createHmac('sha256', runtime.options.input.hashKey)
            .update(encoded.bytes)
            .digest('hex'),
      },
    };
  }

  function ignored(request: http.IncomingMessage): boolean {
    return (
      (request.socket.localPort === collectorPort &&
        (request.url ?? '').startsWith(collector.pathname)) ||
      (runtime.options.input.ignoreIncomingRequest?.(request) ?? false)
    );
  }
  function incoming(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    scheme: 'http' | 'https',
  ): Context {
    const header = single(request.headers.traceparent);
    const candidate = readTraceHandoff(
      single(request.headers[TRACE_HANDOFF_HEADER]),
      {
        traceparent: header,
        hashKeyId: runtime.keyId,
        method: request.method ?? '',
        target: request.url ?? '',
        now: Date.now(),
      },
    );
    let state: State;
    let parent = ROOT_CONTEXT;
    if (
      candidate.kind === 'candidate' &&
      timingSafeEqual(
        createHmac('sha256', runtime.options.input.hashKey)
          .update(candidate.bytes)
          .digest(),
        candidate.signature,
      )
    ) {
      state = runtime.newState(true);
      parent = trace.setSpanContext(parent, {
        ...candidate.context,
        traceFlags: Number.parseInt(candidate.traceparent.slice(-2), 16) & 1,
        isRemote: true,
      });
    } else {
      // A public traceparent is the caller's own trace: a link, never a parent.
      const external = header === null ? null : parseTraceparent(header);
      state = runtime.newState(
        false,
        external === null || header === null
          ? []
          : [
              {
                context: {
                  ...external,
                  traceFlags: Number.parseInt(header.slice(-2), 16) & 1,
                  isRemote: true,
                },
              },
            ],
      );
      if (candidate.kind === 'candidate' || candidate.reason !== 'missing')
        runtime.options.report(
          new CaptureError('handoff_refused', 'context', 1),
        );
    }
    // Names only (rawHeaders is name, value, name, value), kept for an MCP
    // message this request carries: the order and case a client's HTTP
    // library wrote say which library it is.
    state.headerNames = request.rawHeaders.filter(
      (_, index) => index % 2 === 0,
    );
    state.cli = cliAttributesOf(request.rawHeaders, (id) => runtime.hash(id));
    try {
      const location =
        runtime.options.input.incomingLocation?.(request) ?? null;
      state.location =
        location === null
          ? null
          : {
              country: location.country,
              region: location.region,
              city: location.city,
              source: location.source,
            };
    } catch (error) {
      // Application-provided enrichment must not replace its HTTP response.
      runtime.options.report(
        new CaptureError(
          'location_failed',
          'context',
          1,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
    }
    const base = parent.setValue(runtime.stateKey, state);
    const span = tracer.startSpan(
      request.method ?? 'GET',
      {
        kind: SpanKind.SERVER,
        attributes: incomingAttributes(request, scheme),
      },
      base,
    );
    let ended = false;
    response.once('close', () => {
      guard(() => {
        if (ended) return;
        ended = true;
        const status = response.statusCode;
        span.setAttribute('http.response.status_code', status);
        span.setStatus({
          code:
            status >= 100 && status < 500
              ? SpanStatusCode.UNSET
              : SpanStatusCode.ERROR,
        });
        span.end();
      });
    });
    response.on(errorMonitor, (error: Error) => {
      guard(() => {
        if (ended) return;
        ended = true;
        failed(span, error);
        span.end();
      });
    });
    return trace.setSpan(base, span);
  }
  // Published synchronously just before the server emits 'request'.
  function onRequestStart(message: unknown): void {
    const { request, response, server } = message as {
      request: http.IncomingMessage;
      response: http.ServerResponse;
      server: http.Server;
    };
    // Node 22 keeps an entered store on the connection: a later request on
    // it must never inherit this one's.
    ours.enterWith(ROOT_CONTEXT);
    guard(() => {
      if (ignored(request)) return;
      const ctx = incoming(
        request,
        response,
        server instanceof https.Server ? 'https' : 'http',
      );
      ours.enterWith(ctx);
      bind(request, ctx);
      bind(response, ctx);
    });
  }

  function onUndiciCreate(message: unknown): void {
    const { request } = message as { request: UndiciRequest };
    guard(() => {
      const ctx = managed();
      if (
        ctx === undefined ||
        request.method === 'CONNECT' ||
        (request.origin === collector.origin &&
          request.path.startsWith(collector.pathname)) ||
        !URL.canParse(request.path, request.origin)
      )
        return;
      const verb = method(request.method);
      const userAgent = undiciUserAgent(request);
      const span = tracer.startSpan(
        verb === '_OTHER' ? 'HTTP' : verb,
        {
          kind: SpanKind.CLIENT,
          attributes: {
            'http.request.method': verb,
            'url.full': new URL(request.path, request.origin).toString(),
            ...(userAgent === undefined
              ? {}
              : { 'user_agent.original': userAgent }),
          },
        },
        ctx,
      );
      fetches.set(request, span);
      const { remove, set } = rewrite(
        span,
        request.method,
        request.path,
        new URL(request.origin).origin,
      );
      stripUndiciHeaders(request, remove);
      for (const [name, value] of Object.entries(set))
        request.addHeader(name, value);
      if (Object.keys(set).length === 0) return;
      // Another tracer subscribed after this SDK adds its headers next:
      // its traceparent would follow the signed one, and the handoff would
      // no longer match it.
      const add = request.addHeader.bind(request);
      request.addHeader = (name, value) =>
        signedHeaders.includes(name.toLowerCase()) ? request : add(name, value);
    });
  }
  function onUndiciHeaders(message: unknown): void {
    guard(() => {
      const { request, response } = message as {
        request: object;
        response: { statusCode: number };
      };
      const span = fetches.get(request);
      if (span === undefined) return;
      span.setAttribute('http.response.status_code', response.statusCode);
      span.setStatus({
        code:
          response.statusCode >= 400
            ? SpanStatusCode.ERROR
            : SpanStatusCode.UNSET,
      });
    });
  }
  function onUndiciDone(message: unknown): void {
    guard(() => {
      const { request } = message as { request: object };
      fetches.get(request)?.end();
      fetches.delete(request);
    });
  }
  function onUndiciError(message: unknown): void {
    guard(() => {
      const { request, error } = message as { request: object; error: Error };
      const span = fetches.get(request);
      if (span === undefined) return;
      fetches.delete(request);
      // An aborted request is not a failed one.
      if (error.name !== 'AbortError') {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      }
      span.end();
    });
  }

  function outbound(
    request: http.ClientRequest,
    args: readonly unknown[],
    ctx: Context,
    startTime: ReturnType<typeof hrTime>,
    defaultPort: number,
  ): void {
    const options = requestOptions(args);
    // Node's own choice of port, which a ClientRequest never shows; its
    // host, protocol, method and path are the ones it really uses. The Host
    // header, which the caller may set to anything, plays no part.
    const { agent } = request as { agent?: object };
    // As Node chooses: the first that is set and not 0 or ''. An agent's
    // default port counts only as a plain value: a proxy agent's (agent-base)
    // is a getter that reads the call stack, and says 80 outside Node's own
    // https code, so the module's default stands in for it.
    const agentPort = dataProperty(agent, 'defaultPort');
    const port =
      [
        options.port,
        options.defaultPort,
        typeof agentPort === 'number' ? agentPort : undefined,
      ].find(Boolean) ?? defaultPort;
    const host =
      request.host.includes(':') && !request.host.startsWith('[')
        ? `[${request.host}]`
        : request.host;
    const origin = new URL(`${request.protocol}//${host}:${port}`).origin;
    const path = (options.path ?? '') || '/';
    if (origin === collector.origin && path.startsWith(collector.pathname))
      return;
    const { headers } = options;
    // As the caller wrote it, by the rule the export has always followed:
    // only from a headers object, under its lower-case name.
    const userAgent: unknown =
      headers === undefined || isArray(headers)
        ? undefined
        : headers['user-agent'];
    const span = tracer.startSpan(
      request.method,
      {
        kind: SpanKind.CLIENT,
        startTime,
        attributes: {
          'http.request.method': method(request.method),
          'url.full': `${origin}${path}`,
          ...(typeof userAgent === 'string' || typeof userAgent === 'number'
            ? { 'user_agent.original': userAgent }
            : {}),
        },
      },
      ctx,
    );
    const call: Call = { span, ended: false };
    calls.set(request, call);
    request.on('close', () => {
      guard(() => {
        if (call.ended) return;
        call.ended = true;
        span.end();
      });
    });
    request.on(errorMonitor, (error: Error) => {
      guard(() => {
        if (call.ended) return;
        call.ended = true;
        failed(span, error);
        span.end();
      });
    });
    // Headers Node already wrote (an array of them, or `Expect`) are
    // past changing: that call goes without a handoff.
    if (request.headersSent) return;
    const { remove, set } = rewrite(
      span,
      request.method,
      request.path,
      options.socketPath === undefined ? origin : undefined,
    );
    for (const name of remove) request.removeHeader(name);
    for (const [name, value] of Object.entries(set))
      request.setHeader(name, value);
  }
  // Published when a response's headers arrive, before 'response' is
  // emitted. Listening there never changes who reads the body.
  function onResponse(message: unknown): void {
    guard(() => {
      const { request, response } = message as {
        request: object;
        response: http.IncomingMessage;
      };
      const call = calls.get(request);
      if (call === undefined) return;
      const { span } = call;
      const status = response.statusCode;
      if (status !== undefined)
        span.setAttribute('http.response.status_code', status);
      response.on('end', () => {
        guard(() => {
          if (call.ended) return;
          call.ended = true;
          // A response cut short ends in an error instead (`aborted`).
          span.setStatus({
            code:
              status !== undefined && status >= 100 && status < 400
                ? SpanStatusCode.UNSET
                : SpanStatusCode.ERROR,
          });
          span.end();
        });
      });
      response.on(errorMonitor, (error: Error) => {
        guard(() => {
          if (call.ended) return;
          call.ended = true;
          failed(span, error);
          span.end();
        });
      });
    });
  }
  // Published as Node finishes building any ClientRequest. A call made with
  // a function bound before init (a named import under an ESM loader, which
  // never sees the wrappers) is caught here: its port is unknown, so it is
  // neither recorded nor signed, but the SDK's own headers never go on.
  function onRequestCreated(message: unknown): void {
    guard(() => {
      const { request } = message as { request: http.ClientRequest };
      if (building > 0 || request.headersSent || managed() === undefined)
        return;
      for (const name of ownHeaders) request.removeHeader(name);
    });
  }
  function wrap(original: Request, defaultPort: number): Request {
    return function request(this: unknown, ...args) {
      const ctx = installed ? managed() : undefined;
      if (ctx === undefined) return original.apply(this, args);
      const startTime = hrTime();
      let sent: readonly unknown[] = args;
      guard(() => {
        sent = withoutOwnHeaders(args);
      });
      let created: http.ClientRequest;
      building++;
      try {
        created = original.apply(this, sent as unknown[]);
      } finally {
        building--;
      }
      guard(() => {
        outbound(created, sent, ctx, startTime, defaultPort);
      });
      return created;
    };
  }

  const subscriptions: [string, (message: unknown) => void][] = [
    ['http.server.request.start', onRequestStart],
    ['http.client.request.created', onRequestCreated],
    ['http.client.response.finish', onResponse],
    ['undici:request:create', onUndiciCreate],
    ['undici:request:headers', onUndiciHeaders],
    ['undici:request:trailers', onUndiciDone],
    ['undici:request:error', onUndiciError],
  ];
  for (const [name, listener] of subscriptions)
    diagnostics.subscribe(name, listener);
  const restores = (
    [
      [http, 80],
      [https, 443],
    ] as const
  ).map(([module, defaultPort]) => {
    const request = module.request as Request;
    const get = module.get as Request;
    const wrapped = wrap(request, defaultPort);
    // Node's get calls its own request, never the exported one.
    const wrappedGet: Request = function (this: unknown, ...args) {
      const created = wrapped.apply(this, args);
      created.end();
      return created;
    };
    Object.assign(module, { request: wrapped, get: wrappedGet });
    return () => {
      // Another wrapper around this one stays: this one passes calls through.
      if ((module.request as unknown) === wrapped)
        Object.assign(module, { request });
      if ((module.get as unknown) === wrappedGet)
        Object.assign(module, { get });
    };
  });
  syncBuiltinESMExports();
  return () => {
    installed = false;
    for (const [name, listener] of subscriptions)
      diagnostics.unsubscribe(name, listener);
    for (const restore of restores) restore();
    syncBuiltinESMExports();
  };
}
