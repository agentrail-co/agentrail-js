import { context, createContextKey, SpanStatusCode } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import type {
  McpHandlerRequestOptions,
  MessageExtraInfo,
  ServerContext,
  Transport,
} from '@modelcontextprotocol/server';
import { createParser } from 'eventsource-parser';
import type { AgentrailNode } from './client.js';
import { MCP_PAYLOAD_BYTES } from './limits.js';
import { CaptureError } from './options.js';
import { boundedText } from './privacy.js';
import { internalOf, type McpFacts } from './runtime.js';

/** One MCP call as the redact hook sees it, before anything leaves the process. */
export interface McpPayload {
  readonly method: string;
  /** The tool or prompt name, or the resource URI; null for other methods. */
  readonly name: string | null;
  /** The request's params, as received. */
  readonly request: unknown;
  /** The result, or the JSON-RPC error object. */
  readonly response: unknown;
}
export interface McpPayloadCapture {
  /**
   * Returns what of the call may leave the process, sent as JSON text, or
   * null to send neither. It runs for every call the transport captures.
   */
  redact(
    payload: McpPayload,
  ): { readonly request: unknown; readonly response: unknown } | null;
}
export interface McpCaptureOptions {
  readonly client: AgentrailNode;
  /**
   * Off unless set: request params and results then leave the process as
   * `redact` returns them, on transport spans only.
   */
  readonly capturePayloads?: McpPayloadCapture;
}

type Message = Readonly<Record<string, unknown>>;
interface ClientFacts {
  client?: string;
  clientVersion?: string;
  protocol?: string;
}
interface Call {
  /** Undefined for a notification. */
  readonly id: unknown;
  readonly method: string;
  readonly name: string | null;
  readonly params: unknown;
  readonly span: Span;
  readonly ctx: Context;
  readonly facts: McpFacts;
}
/** The transport spans a request's handlers run under, by JSON-RPC id. */
const callsKey = createContextKey('agentrail.mcp.calls');
const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
/** The most of a request body the handler wrapper reads to see its messages. */
const MAX_INSPECTED_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Message | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Message)
    : undefined;
}
/** A JSON-RPC id as a map key: 1 and "1" stay apart. */
function idKey(id: unknown): string | undefined {
  return typeof id === 'string' || typeof id === 'number'
    ? JSON.stringify(id)
    : undefined;
}
/** JSON text as the MCP SDK encodes a message; undefined for what JSON cannot hold. */
function jsonText(value: unknown): string | undefined {
  try {
    // JSON.stringify gives undefined for undefined, a function or a symbol.
    const text: string | undefined = JSON.stringify(value);
    return text;
  } catch (error) {
    // A cycle or a BigInt: an in-process transport can carry either.
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
/** JSON text of what the redact hook returned; a cycle or a BigInt throws to the hook's failure. */
function jsonOf(value: unknown): string | undefined {
  const text: string | undefined = JSON.stringify(value);
  return text;
}
function jsonBytes(value: unknown): number | undefined {
  const text = jsonText(value);
  return text === undefined ? undefined : Buffer.byteLength(text);
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function nameOf(method: string, params: Message | undefined): string | null {
  const name =
    method === 'resources/read'
      ? params?.uri
      : method === 'tools/call' || method === 'prompts/get'
        ? params?.name
        : undefined;
  // An empty name is no name: the span is mcp.<method>, with no colon.
  return typeof name === 'string' && name !== '' ? name : null;
}
function spanName(method: string, name: string | null): string {
  return boundedText(
    name === null ? `mcp.${method}` : `mcp.${method}:${name}`,
    256,
  );
}
function kindOf(method: string): string {
  return method === 'tools/call'
    ? 'tool.call'
    : boundedText(`mcp.${method}`, 256);
}
function failed(span: Span, type: string): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute('error.type', type);
}
/** What the client declared in its initialize, for the messages after it. */
type Declared = Pick<ClientFacts, 'client' | 'clientVersion'>;
/**
 * Self-reported client facts. The protocol is what this message carried
 * (initialize params, its envelope, the header), never negotiated nor
 * remembered; the client's name and version are its envelope's, else what
 * it declared in initialize.
 */
function clientOf(
  method: string,
  params: Message | undefined,
  header: string | null | undefined,
  declared: Declared,
): ClientFacts {
  const meta = record(params?._meta);
  const info =
    (method === 'initialize' ? record(params?.clientInfo) : undefined) ??
    record(meta?.[CLIENT_INFO]);
  const client = boundedText(info?.name, 128) ?? declared.client;
  const clientVersion =
    boundedText(info?.version, 128) ?? declared.clientVersion;
  const protocol = boundedText(
    (method === 'initialize' ? params?.protocolVersion : undefined) ??
      meta?.[PROTOCOL_VERSION] ??
      header,
    64,
  );
  return {
    ...(client === undefined ? {} : { client }),
    ...(clientVersion === undefined ? {} : { clientVersion }),
    ...(protocol === undefined ? {} : { protocol }),
  };
}
/** Cut UTF-8 text to at most `limit` bytes on a character boundary, so it stays well-formed. */
function truncated(text: string, limit: number): string {
  const bytes = Buffer.from(text, 'utf8');
  let end = limit;
  // A continuation byte (10xxxxxx) at the cut belongs to a character it would split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
type PayloadFacts = Pick<
  McpFacts,
  | 'requestPayload'
  | 'responsePayload'
  | 'requestTruncated'
  | 'responseTruncated'
>;
/** Payloads as one span carries them: cut only when together they cannot fit one export. */
function fitted(
  request: string | undefined,
  response: string | undefined,
): PayloadFacts {
  const requestBytes = request === undefined ? 0 : Buffer.byteLength(request);
  const responseBytes =
    response === undefined ? 0 : Buffer.byteLength(response);
  const facts: PayloadFacts = {};
  if (requestBytes + responseBytes <= MCP_PAYLOAD_BYTES) {
    if (request !== undefined) facts.requestPayload = request;
    if (response !== undefined) facts.responsePayload = response;
    return facts;
  }
  // Each gets half; one that needs less leaves the rest to the other.
  const half = Math.floor(MCP_PAYLOAD_BYTES / 2);
  const requestLimit =
    requestBytes <= half
      ? requestBytes
      : Math.max(half, MCP_PAYLOAD_BYTES - responseBytes);
  const responseLimit = MCP_PAYLOAD_BYTES - requestLimit;
  if (request !== undefined)
    if (requestBytes > requestLimit) {
      facts.requestPayload = truncated(request, requestLimit);
      facts.requestTruncated = true;
    } else facts.requestPayload = request;
  if (response !== undefined)
    if (responseBytes > responseLimit) {
      facts.responsePayload = truncated(response, responseLimit);
      facts.responseTruncated = true;
    } else facts.responsePayload = response;
  return facts;
}
/** Reads a request body copy, up to a bound; undefined past it or when it cannot be read. */
async function bodyText(request: Request): Promise<string | undefined> {
  const copy = request.bodyUsed ? null : request.clone().body;
  if (copy === null) return undefined;
  const reader = copy.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks).toString('utf8');
      total += value.byteLength;
      if (total > MAX_INSPECTED_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch (error) {
    // The handler reads its own copy and answers a body that cannot be read
    // (the client went away mid-upload); this copy only goes without spans.
    if (error instanceof Error) return undefined;
    throw error;
  }
}

/**
 * Captures MCP calls through public APIs only; no transport is patched.
 *
 * - `transport(t)` wraps a transport you own before `server.connect`: one
 *   step per JSON-RPC message the server receives.
 * - `handler(h)` wraps what `createMcpHandler` returns, the same way.
 * - `tool`, `resource` and `prompt` wrap the callbacks you register: inside a
 *   wrapped transport, each is the call's child span; alone, it is the step.
 */
export function mcp(options: McpCaptureOptions) {
  const internal = internalOf(options.client);
  const { runtime } = internal;

  function begin(
    message: Message,
    header: string | null | undefined,
    declared: Declared,
  ): Call | undefined {
    const { method } = message;
    // A response the client sent back to a server request is not a call.
    if (typeof method !== 'string') return undefined;
    const params = record(message.params);
    const name = nameOf(method, params);
    const facts: McpFacts = { layer: 'transport', method };
    const bytes = jsonBytes(message);
    if (bytes !== undefined) facts.requestBytes = bytes;
    const client = clientOf(method, params, header, declared);
    if (method === 'initialize') {
      if (client.client !== undefined) declared.client = client.client;
      if (client.clientVersion !== undefined)
        declared.clientVersion = client.clientVersion;
    }
    const { span, ctx } = internal.start(
      spanName(method, name),
      { surface: 'mcp', kind: kindOf(method), mcp: { method, ...client } },
      { mcpFacts: facts },
    );
    return {
      id: 'id' in message ? message.id : undefined,
      method,
      name,
      params: message.params,
      span,
      ctx,
      facts,
    };
  }

  function capture(
    hook: McpPayloadCapture,
    call: Call,
    response: unknown,
  ): void {
    let request: string | undefined;
    let result: string | undefined;
    try {
      const redacted = hook.redact({
        method: call.method,
        name: call.name,
        request: call.params,
        response,
      });
      if (redacted === null) return;
      request = jsonOf(redacted.request);
      result = jsonOf(redacted.response);
    } catch (error) {
      // The application's hook, or what it returned, failed: the call goes
      // on unaffected, and its span goes without payloads.
      runtime.options.report(
        new CaptureError(
          'payload_redact_failed',
          'traces',
          1,
          error instanceof Error ? error : new Error(String(error)),
        ),
      );
      return;
    }
    Object.assign(call.facts, fitted(request, result));
  }

  function finish(
    call: Call,
    response: Message | undefined,
    sessionId: string | null | undefined,
  ): void {
    const { span, facts } = call;
    if (typeof sessionId === 'string' && sessionId !== '')
      facts.sessionHash = runtime.hash(sessionId);
    if (response !== undefined) {
      const bytes = jsonBytes(response);
      if (bytes !== undefined) facts.responseBytes = bytes;
      const error = record(response.error);
      if (error !== undefined) {
        if (Number.isSafeInteger(error.code))
          facts.errorCode = error.code as number;
        failed(span, 'McpJsonRpcError');
      } else if (
        call.method === 'tools/call' &&
        record(response.result)?.isError === true
      ) {
        facts.isError = true;
        failed(span, 'McpOperationError');
      }
      if (options.capturePayloads !== undefined)
        capture(options.capturePayloads, call, error ?? response.result);
    } else if (options.capturePayloads !== undefined)
      // A notification, or a request never answered: its request still goes.
      capture(options.capturePayloads, call, undefined);
    span.end();
  }

  /** Wraps a transport you own; pass the result to `server.connect`. */
  function transport<T extends Transport>(inner: T): T {
    const pending = new Map<string, Call>();
    // One transport is one connection: its initialize names the client.
    const declared: Declared = {};
    let onmessage = inner.onmessage;
    let onclose = inner.onclose;
    const received = (
      message: Parameters<NonNullable<Transport['onmessage']>>[0],
      extra?: MessageExtraInfo,
    ) => {
      const deliver = () => {
        onmessage?.(message, extra);
      };
      const call = begin(
        message,
        extra?.request?.headers.get('mcp-protocol-version'),
        declared,
      );
      if (call === undefined) {
        deliver();
        return;
      }
      const key = idKey(call.id);
      if (key === undefined) {
        try {
          context.with(call.ctx, deliver);
        } finally {
          finish(call, undefined, inner.sessionId);
          // A request the client gave up on gets no response.
          if (call.method === 'notifications/cancelled') {
            const cancelled = idKey(record(call.params)?.requestId);
            const gone =
              cancelled === undefined ? undefined : pending.get(cancelled);
            if (cancelled !== undefined && gone !== undefined) {
              pending.delete(cancelled);
              finish(gone, undefined, inner.sessionId);
            }
          }
        }
        return;
      }
      pending.set(key, call);
      context.with(call.ctx.setValue(callsKey, pending), deliver);
    };
    const send: Transport['send'] = (message, sendOptions) => {
      const sent = message as unknown as Message;
      const key =
        'method' in sent || !('result' in sent || 'error' in sent)
          ? undefined
          : idKey(sent.id);
      const call = key === undefined ? undefined : pending.get(key);
      if (key !== undefined && call !== undefined) {
        pending.delete(key);
        finish(call, sent, inner.sessionId);
      }
      return inner.send(message, sendOptions);
    };
    const closed = () => {
      for (const call of pending.values())
        finish(call, undefined, inner.sessionId);
      pending.clear();
      onclose?.();
    };
    // Everything else reaches the transport itself, so its own methods
    // (`handleRequest`) work through the wrapper too.
    return new Proxy(inner, {
      get(target, property) {
        if (property === 'send') return send;
        if (property === 'onmessage') return onmessage;
        if (property === 'onclose') return onclose;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
      set(target, property, value) {
        if (property === 'onmessage') {
          onmessage = value as Transport['onmessage'];
          target.onmessage = onmessage === undefined ? undefined : received;
          return true;
        }
        if (property === 'onclose') {
          onclose = value as Transport['onclose'];
          target.onclose = closed;
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
  }

  function observe(
    request: Request,
    response: Response,
    calls: readonly Call[],
  ): void {
    // Only an id the server issued; one a request alone carried is not a session.
    const session = response.headers.get('mcp-session-id');
    const waiting = new Map<string, Call>();
    for (const call of calls) {
      const key = idKey(call.id);
      if (key === undefined) finish(call, undefined, session);
      else waiting.set(key, call);
    }
    if (waiting.size === 0) return;
    // Left without a JSON-RPC answer: refused, where the status says so.
    const rest = () => {
      for (const call of waiting.values()) {
        if (response.status >= 400) failed(call.span, 'McpTransportRejected');
        finish(call, undefined, session);
      }
      waiting.clear();
    };
    const answered = (value: unknown) => {
      for (const item of Array.isArray(value) ? value : [value]) {
        const message = record(item);
        if (
          message === undefined ||
          'method' in message ||
          !('result' in message || 'error' in message)
        )
          continue;
        // A request refused before its id was read is answered with id null.
        const key =
          idKey(message.id) ??
          (message.id === null && waiting.size === 1
            ? [...waiting.keys()][0]
            : undefined);
        const call = key === undefined ? undefined : waiting.get(key);
        if (key === undefined || call === undefined) continue;
        waiting.delete(key);
        finish(call, message, session);
      }
    };
    const type = response.headers.get('content-type') ?? '';
    if (response.body === null) rest();
    else if (type.includes('text/event-stream'))
      // A tee'd copy: the client's copy is never delayed or changed.
      void events(
        response.clone(),
        request.signal,
        answered,
        () => waiting.size === 0,
      ).then(rest);
    else if (type.includes('json'))
      void response
        .clone()
        .text()
        .then((text) => {
          answered(parseJson(text));
        }, ended)
        .then(rest);
    else rest();
  }

  /** Wraps what `createMcpHandler` returns; serve the result in its place. */
  function handler<
    H extends {
      readonly fetch: (
        request: Request,
        options?: McpHandlerRequestOptions,
      ) => Promise<Response>;
    },
  >(inner: H): H {
    const fetch = async (
      request: Request,
      requestOptions?: McpHandlerRequestOptions,
    ): Promise<Response> => {
      if (request.method.toUpperCase() !== 'POST')
        return inner.fetch(request, requestOptions);
      let body = requestOptions?.parsedBody;
      if (body === undefined) {
        const text = await bodyText(request);
        body = text === undefined ? undefined : parseJson(text);
      }
      const header = request.headers.get('mcp-protocol-version');
      // A stateless request is its own connection: only an initialize in it declares the client.
      const declared: Declared = {};
      const calls = (Array.isArray(body) ? body : [body]).flatMap((item) => {
        const message = record(item);
        const call =
          message === undefined ? undefined : begin(message, header, declared);
        return call === undefined ? [] : [call];
      });
      const [only] = calls;
      if (only === undefined) return inner.fetch(request, requestOptions);
      const byId = new Map<string, Call>();
      for (const call of calls) {
        const key = idKey(call.id);
        if (key !== undefined) byId.set(key, call);
      }
      // One message runs under its span; a batch's handlers find theirs by id.
      const ctx = (calls.length === 1 ? only.ctx : context.active()).setValue(
        callsKey,
        byId,
      );
      let response: Response;
      try {
        response = await context.with(ctx, () =>
          inner.fetch(request, requestOptions),
        );
      } catch (error) {
        for (const call of calls) {
          call.span.setStatus({ code: SpanStatusCode.ERROR });
          if (error instanceof Error)
            call.span.setAttribute('error.type', error.name);
          finish(call, undefined, null);
        }
        throw error;
      }
      observe(request, response, calls);
      return response;
    };
    return { ...inner, fetch };
  }

  function wrap<Args extends unknown[], Result>(
    method: string,
    name: string,
    callback: (...args: Args) => Result | Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => {
      // All supported registration callbacks receive ServerContext as their final argument.
      const ctx = args.at(-1) as ServerContext;
      const calls = context.active().getValue(callsKey) as
        ReadonlyMap<string, Call> | undefined;
      const key = idKey(ctx.mcpReq.id);
      const parent = key === undefined ? undefined : calls?.get(key);
      const kind = kindOf(method);
      if (parent !== undefined)
        // The transport span is the call; this is the work inside it.
        return context.with(parent.ctx, () =>
          run(
            internal.start(
              spanName(method, name),
              { surface: 'mcp', kind },
              { step: false, mcpFacts: { layer: 'handler', method } },
            ),
            () => callback(...args),
          ),
        );
      const envelope = record(ctx.mcpReq.envelope);
      const client = clientOf(
        method,
        // The envelope is what a request's `_meta` carries.
        { _meta: envelope },
        ctx.http?.req?.headers.get('mcp-protocol-version'),
        {},
      );
      const facts: McpFacts = { layer: 'handler', method };
      if (typeof ctx.sessionId === 'string' && ctx.sessionId !== '')
        facts.sessionHash = runtime.hash(ctx.sessionId);
      return run(
        internal.start(
          spanName(method, name),
          { surface: 'mcp', kind, mcp: { method, ...client } },
          { mcpFacts: facts },
        ),
        () => callback(...args),
        facts,
      );
    };
  }
  function run<Result>(
    started: { span: Span; ctx: Context },
    callback: () => Result | Promise<Result>,
    /** A step's facts: alone, the handler carries what a transport span would. */
    step?: McpFacts,
  ): Promise<Result> {
    const { span } = started;
    return context.with(started.ctx, async () => {
      try {
        const result = await callback();
        if (record(result)?.isError === true) {
          failed(span, 'McpOperationError');
          if (step?.method === 'tools/call') step.isError = true;
        }
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof Error) span.setAttribute('error.type', error.name);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  return {
    transport,
    handler,
    tool: <Args extends unknown[], Result>(
      name: string,
      callback: (...args: Args) => Result | Promise<Result>,
    ) => wrap('tools/call', name, callback),
    resource: <Args extends unknown[], Result>(
      name: string,
      callback: (...args: Args) => Result | Promise<Result>,
    ) => wrap('resources/read', name, callback),
    prompt: <Args extends unknown[], Result>(
      name: string,
      callback: (...args: Args) => Result | Promise<Result>,
    ) => wrap('prompts/get', name, callback),
  };
}

/** Feeds each JSON message of an SSE copy to `answered`, until `done` or the request is gone. */
async function events(
  copy: Response,
  signal: AbortSignal,
  answered: (value: unknown) => void,
  done: () => boolean,
): Promise<void> {
  if (copy.body === null) return;
  const reader = copy.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = createParser({
    onEvent: (event) => {
      answered(parseJson(event.data));
    },
  });
  // A tee'd stream is cancelled at its source only once both copies are:
  // this copy lets go when the client does, or once every call is answered.
  const abandon = () => {
    reader.cancel().catch(ended);
  };
  signal.addEventListener('abort', abandon, { once: true });
  try {
    while (!done()) {
      let chunk: ReadableStreamReadResult<string>;
      try {
        chunk = await reader.read();
      } catch (error) {
        ended(error);
        return;
      }
      if (chunk.done) return;
      parser.feed(chunk.value);
    }
    abandon();
  } finally {
    signal.removeEventListener('abort', abandon);
  }
}
/** The stream failed (the client went away): the calls left end without a response. */
function ended(error: unknown): void {
  if (!(error instanceof Error)) throw error;
}
