import { createHmac, timingSafeEqual } from 'node:crypto';
import { ClientRequest } from 'node:http';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Context, Span, TextMapPropagator } from '@opentelemetry/api';
import type { HttpInstrumentationConfig } from '@opentelemetry/instrumentation-http';
import type {
  UndiciInstrumentationConfig,
  UndiciRequest,
} from '@opentelemetry/instrumentation-undici';
import {
  encodeTraceHandoff,
  readTraceHandoff,
  TRACE_HANDOFF_HEADER,
  parseTraceparent,
} from 'agentrail-core';
import { isCaptureSuppressed } from './suppression.js';
import { CaptureError } from './options.js';
import type { Runtime, State } from './runtime.js';

const ownedHeaders = [
  'traceparent',
  'sentry-trace',
  'tracestate',
  'baggage',
  TRACE_HANDOFF_HEADER,
];
function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}
export function httpCapture(runtime: Runtime) {
  const requests = new WeakMap<object, Context>();
  const ports = new WeakMap<object, number>();
  const collector = new URL(runtime.options.endpoint);
  const base = runtime.options.input.propagator;
  const propagator: TextMapPropagator = {
    // Undici injects AFTER requestHook. Managed propagation is already signed/filtered there.
    inject(ctx, carrier: unknown, setter) {
      if (runtime.state(ctx) !== undefined || isCaptureSuppressed(ctx)) return;
      base?.inject(ctx, carrier, setter);
    },
    extract(ctx, carrier: unknown, getter) {
      const incoming =
        typeof carrier === 'object' && carrier !== null
          ? requests.get(carrier)
          : undefined;
      return incoming ?? base?.extract(ctx, carrier, getter) ?? ROOT_CONTEXT;
    },
    fields: () => [...new Set([...ownedHeaders, ...(base?.fields() ?? [])])],
  };

  function sign(
    span: Span,
    method: string,
    target: string,
    origin: string,
  ): Record<string, string> {
    if (!runtime.spans.has(span) || !runtime.options.origins.has(origin))
      return {};
    const sc = span.spanContext();
    const traceparent = `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, '0')}`;
    const encoded = encodeTraceHandoff({
      traceparent,
      hashKeyId: runtime.keyId,
      issuedAt: Date.now(),
      method,
      target,
    });
    return {
      traceparent,
      [TRACE_HANDOFF_HEADER]:
        encoded.tokenPrefix +
        createHmac('sha256', runtime.options.input.hashKey)
          .update(encoded.bytes)
          .digest('hex'),
    };
  }
  const httpOptions: HttpInstrumentationConfig = {
    requireParentforOutgoingSpans: true,
    ignoreIncomingRequestHook: (request) =>
      (request.socket.localPort ===
        Number(
          collector.port || (collector.protocol === 'https:' ? 443 : 80),
        ) &&
        (request.url ?? '').startsWith(collector.pathname)) ||
      (runtime.options.input.ignoreIncomingRequest?.(request) ?? false),
    ignoreOutgoingRequestHook: (request) =>
      (request.hostname ?? request.host) === collector.hostname &&
      Number(request.port ?? (request.protocol === 'https:' ? 443 : 80)) ===
        Number(
          collector.port || (collector.protocol === 'https:' ? 443 : 80),
        ) &&
      (request.path ?? '').startsWith(collector.pathname),
    startIncomingSpanHook(request) {
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
      let ctx = ROOT_CONTEXT;
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
        ctx = trace.setSpanContext(ctx, {
          ...candidate.context,
          traceFlags: Number.parseInt(candidate.traceparent.slice(-2), 16) & 1,
          isRemote: true,
        });
      } else {
        const external = header === null ? null : parseTraceparent(header);
        state = runtime.newState(
          false,
          external === null
            ? []
            : [
                {
                  context: {
                    ...external,
                    traceFlags:
                      header === null
                        ? 0
                        : Number.parseInt(header.slice(-2), 16) & 1,
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
      requests.set(request.headers, ctx.setValue(runtime.stateKey, state));
      return {};
    },
    startOutgoingSpanHook(request) {
      // The SDK span processor gets these before requestHook. Never trust Host for destination allowlisting.
      return {
        'agentrail.network.port': Number(
          request.port ?? (request.protocol === 'https:' ? 443 : 80),
        ),
      };
    },
    requestHook(span, request) {
      if (!(request instanceof ClientRequest)) {
        if (!span.isRecording())
          runtime.options.report(
            new CaptureError('entry_not_recording', 'traces', 1),
          );
        return;
      }
      const metadata = runtime.spans.get(span);
      if (metadata === undefined) return;
      for (const header of ownedHeaders) request.removeHeader(header);
      const port = ports.get(span);
      // Public ClientRequest.host is the actual connection hostname; its Host header may be overridden.
      const hostname =
        request.host.includes(':') && !request.host.startsWith('[')
          ? `[${request.host}]`
          : request.host;
      const origin = new URL(
        `${request.protocol}//${hostname}${port === undefined ? '' : `:${port}`}`,
      ).origin;
      for (const [key, value] of Object.entries(
        sign(span, request.method, request.path, origin),
      ))
        request.setHeader(key, value);
    },
  };
  const undiciOptions: UndiciInstrumentationConfig = {
    requireParentforSpans: true,
    ignoreRequestHook: (request) =>
      request.origin === collector.origin &&
      request.path.startsWith(collector.pathname),
    requestHook(span, request) {
      if (!runtime.spans.has(span)) return;
      stripUndiciHeaders(request);
      for (const [key, value] of Object.entries(
        sign(
          span,
          request.method,
          request.path,
          new URL(request.origin).origin,
        ),
      ))
        request.addHeader(key, value);
    },
  };
  return {
    propagator,
    httpOptions,
    undiciOptions,
    rememberPort(span: object, value: unknown) {
      if (typeof value === 'number') ports.set(span, value);
    },
  };
}
function stripUndiciHeaders(request: UndiciRequest): void {
  if (typeof request.headers === 'string')
    request.headers = request.headers
      .split('\r\n')
      .filter(
        (line) =>
          !ownedHeaders.includes(
            line.slice(0, line.indexOf(':')).toLowerCase(),
          ),
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
        !ownedHeaders.includes(name.toLowerCase())
      )
        headers.push(name, value);
    }
    request.headers = headers;
  }
}
