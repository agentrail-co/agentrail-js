import { parseMarker } from 'agentrail-core';
import { randomUUID } from 'node:crypto';
import { trace, SpanKind } from '@opentelemetry/api';
import type { Attributes, Context, SpanContext } from '@opentelemetry/api';
import { millisToHrTime } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { LogAttributes, SeverityNumber } from '@opentelemetry/api-logs';
import type { McpFacts, Runtime } from './runtime.js';

export interface StructuredLog {
  readonly severityNumber?: SeverityNumber;
  readonly severityText?: string;
  readonly errorType?: string;
  readonly eventName?: string;
  /** Only explicitly selected fields are included as message text. */
  readonly fields?: Readonly<Record<string, unknown>>;
}
export function spanContextOnly(input: SpanContext): SpanContext {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    traceFlags: input.traceFlags,
    ...(input.isRemote === undefined ? {} : { isRemote: input.isRemote }),
  };
}
const scope = { name: 'agentrail-node' };
export function boundedText(input: string, limit: number): string;
export function boundedText(input: unknown, limit: number): string | undefined;
export function boundedText(input: unknown, limit: number): string | undefined {
  return typeof input === 'string'
    ? input.replaceAll('\u0000', '').slice(0, limit).toWellFormed()
    : undefined;
}
function text(input: unknown): string | undefined {
  return boundedText(input, 4096);
}

function sanitizedUrl(input: unknown): string | undefined {
  if (typeof input !== 'string' || !URL.canParse(input)) return undefined;
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol)) return undefined;
  const markers = url.searchParams.getAll('h');
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  for (const marker of markers)
    if (parseMarker(marker).valid) url.searchParams.append('h', marker);
  // Omit optional URL evidence instead of truncating its meaning or rejecting unrelated spans in the batch.
  return url.href.length <= 4096 ? url.href : undefined;
}
export function copySpan(
  span: ReadableSpan,
  runtime: Runtime,
): ReadableSpan | undefined {
  const metadata = runtime.spans.get(span);
  if (metadata === undefined) return undefined;
  const attrs: Attributes = {};
  const original = span.attributes;
  const fields = {
    'http.request.method':
      original['http.request.method'] ?? original['http.method'],
    'http.route': original['http.route'],
    'http.response.status_code':
      original['http.response.status_code'] ?? original['http.status_code'],
    'user_agent.original':
      original['user_agent.original'] ?? original['http.user_agent'],
    'error.type':
      original['error.type'] ??
      original['exception.type'] ??
      span.events.find((event) => event.name === 'exception')?.attributes?.[
        'exception.type'
      ],
  };
  for (const [key, value] of Object.entries(fields))
    if (typeof value === 'number' || typeof value === 'string')
      attrs[key] = typeof value === 'string' ? boundedText(value, 4096) : value;
  const address = original['server.address'];
  const path = original['url.path'];
  const scheme = original['url.scheme'];
  const port = original['server.port'];
  const query = original['url.query'];
  const incomingUrl =
    typeof address === 'string' &&
    typeof path === 'string' &&
    typeof scheme === 'string'
      ? `${scheme}://${address}${typeof port === 'number' ? `:${port}` : ''}${path}${typeof query === 'string' ? `?${query}` : ''}`
      : undefined;
  const url = sanitizedUrl(
    original['url.full'] ?? original['http.url'] ?? incomingUrl,
  );
  if (url !== undefined) attrs['url.full'] = url;
  // An MCP handler inside its transport span is neither a step nor an entry:
  // the transport span is the call.
  const mark = metadata.mark?.step === false ? undefined : metadata.mark;
  const step = mark !== undefined;
  const entry =
    step || span.kind === SpanKind.SERVER || span.kind === SpanKind.CONSUMER;
  if (entry)
    Object.assign(attrs, metadata.mark?.identity ?? metadata.state.identity);
  if (entry && metadata.state.location) {
    const location = metadata.state.location;
    for (const field of ['country', 'region', 'city', 'source'] as const) {
      const value = location[field];
      if (value !== null)
        attrs[`agentrail.client.location.${field}`] = boundedText(value, 128);
    }
  }
  if (span.kind === SpanKind.SERVER)
    attrs['agentrail.ingress.verified'] = metadata.state.verifiedIngress;
  if (mark !== undefined)
    Object.assign(attrs, {
      'agentrail.step': true,
      'agentrail.step.surface': mark.surface,
      'agentrail.step.kind': mark.kind,
    });
  if (metadata.mark?.performance !== undefined)
    Object.assign(attrs, metadata.mark.performance);
  const mcp = metadata.mark?.mcp;
  if (mcp !== undefined) {
    if (mcp.client !== undefined)
      attrs['agentrail.mcp.client.name'] = boundedText(mcp.client, 128);
    if (mcp.clientVersion !== undefined)
      attrs['agentrail.mcp.client.version'] = boundedText(
        mcp.clientVersion,
        128,
      );
    if (mcp.protocol !== undefined)
      attrs['agentrail.mcp.protocol.version'] = boundedText(mcp.protocol, 64);
  }
  const facts = metadata.mark?.mcpFacts;
  if (facts !== undefined) Object.assign(attrs, mcpAttributes(facts));
  const parent = span.parentSpanContext;
  return {
    name: boundedText(
      metadata.mark?.name ??
        (typeof attrs['http.request.method'] === 'string'
          ? `HTTP ${attrs['http.request.method']}`
          : 'backend.operation'),
      4096,
    ),
    kind: span.kind,
    spanContext: () => spanContextOnly(span.spanContext()),
    ...(parent === undefined
      ? {}
      : { parentSpanContext: spanContextOnly(parent) }),
    startTime: [...span.startTime],
    endTime: [...span.endTime],
    duration: [...span.duration],
    ended: span.ended,
    status: { code: span.status.code },
    attributes: attrs,
    links: [
      ...span.links,
      ...(span.kind === SpanKind.SERVER ? metadata.state.links : []),
    ].map((link) => ({ context: spanContextOnly(link.context) })),
    events: [],
    resource: runtime.resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}
/** A method the collector keeps; any other is named only in the span name. */
const MCP_METHOD = /^[A-Za-z0-9_./-]{1,128}$/u;
function mcpAttributes(facts: McpFacts): Attributes {
  const attrs: Attributes = { 'agentrail.mcp.layer': facts.layer };
  const optional = {
    'agentrail.mcp.method': MCP_METHOD.test(facts.method)
      ? facts.method
      : undefined,
    'agentrail.mcp.session.id_hash': facts.sessionHash,
    'agentrail.mcp.request.bytes': facts.requestBytes,
    'agentrail.mcp.response.bytes': facts.responseBytes,
    'agentrail.mcp.jsonrpc.error_code': facts.errorCode,
    'agentrail.mcp.result.is_error': facts.isError,
    // JSON text after the application's redact hook, never bounded by the
    // 4,096-character cap: the capture truncates it only to fit one export.
    'agentrail.mcp.request.payload': facts.requestPayload,
    'agentrail.mcp.response.payload': facts.responsePayload,
    'agentrail.mcp.request.truncated': facts.requestTruncated,
    'agentrail.mcp.response.truncated': facts.responseTruncated,
  };
  for (const [key, value] of Object.entries(optional))
    if (value !== undefined) attrs[key] = value;
  return attrs;
}
const PAYLOAD_ATTRIBUTES = [
  'agentrail.mcp.request.payload',
  'agentrail.mcp.response.payload',
  'agentrail.mcp.request.truncated',
  'agentrail.mcp.response.truncated',
];
/** The UTF-8 size of the MCP payload text an exported span holds. */
export function payloadBytes(span: ReadableSpan): number {
  let total = 0;
  for (const key of PAYLOAD_ATTRIBUTES) {
    const value = span.attributes[key];
    if (typeof value === 'string') total += Buffer.byteLength(value);
  }
  return total;
}
/** The exported span without its MCP payloads. */
export function withoutPayloads(span: ReadableSpan): ReadableSpan {
  const attributes = { ...span.attributes };
  for (const key of PAYLOAD_ATTRIBUTES) Reflect.deleteProperty(attributes, key);
  return { ...span, attributes };
}
/**
 * An upper estimate of an exported span's OTLP protobuf size: its text as
 * UTF-8, and a generous allowance for each field's tag, length and value.
 */
export function estimatedBytes(span: ReadableSpan): number {
  let total = 128 + Buffer.byteLength(span.name) + span.links.length * 64;
  for (const [key, value] of Object.entries(span.attributes))
    total +=
      16 +
      Buffer.byteLength(key) +
      (typeof value === 'string' ? Buffer.byteLength(value) : 16);
  return total;
}
/** Fit an already-sanitized string, including JSON escaping, without splitting a code point. */
function fitLogText(value: string, budget: number): string {
  const prefix = (length: number) => {
    const part = value.slice(0, length);
    return part.isWellFormed() ? part : part.slice(0, -1);
  };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(prefix(middle)).length <= budget) low = middle;
    else high = middle - 1;
  }
  return prefix(low);
}

function selectedBody(
  fields: Readonly<Record<string, unknown>>,
  selected: readonly string[],
): string | undefined {
  let result: Record<string, string | number | boolean | null> = {};
  let body: string | undefined;
  for (const field of selected) {
    const value = fields[field];
    let scalar: string | number | boolean | null;
    if (typeof value === 'string') scalar = boundedText(value, 4096);
    else if (
      typeof value === 'boolean' ||
      value === null ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      scalar = value;
    else continue;
    const candidate = { ...result, [field]: scalar };
    let encoded = JSON.stringify(candidate);
    if (encoded.length > 4096) {
      if (typeof scalar !== 'string') continue;
      const overhead = JSON.stringify({ ...result, [field]: '' }).length - 2;
      const budget = 4096 - overhead;
      if (budget < 2) continue;
      candidate[field] = fitLogText(scalar, budget);
      encoded = JSON.stringify(candidate);
    }
    result = candidate;
    body = encoded;
  }
  return body;
}
export function copyLog(
  record: ReadableLogRecord,
  runtime: Runtime,
): ReadableLogRecord | undefined {
  if (
    runtime.options.input.logs?.uncorrelated === false &&
    record.spanContext === undefined
  )
    return undefined;
  const body = selectedBody(
    { message: record.body, ...record.attributes },
    runtime.options.input.logs?.includeFields ?? [],
  );
  const attributes: LogAttributes = { 'agentrail.log.id': randomUUID() };
  const error = text(
    record.attributes['error.type'] ?? record.attributes['exception.type'],
  );
  if (error !== undefined) attributes['error.type'] = error;
  if (body !== undefined) attributes['agentrail.log.body_allowed'] = true;
  return {
    hrTime: [...record.hrTime],
    hrTimeObserved: [...record.hrTimeObserved],
    ...(record.spanContext === undefined
      ? {}
      : { spanContext: spanContextOnly(record.spanContext) }),
    ...(record.severityNumber === undefined
      ? {}
      : { severityNumber: record.severityNumber }),
    ...(record.severityText === undefined
      ? {}
      : { severityText: boundedText(record.severityText, 64) }),
    ...(record.eventName === undefined
      ? {}
      : { eventName: boundedText(record.eventName, 256) }),
    ...(body === undefined ? {} : { body }),
    attributes,
    resource: runtime.resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
  };
}
export function makeLog(
  input: StructuredLog,
  ctx: Context,
  runtime: Runtime,
): ReadableLogRecord | undefined {
  const state = runtime.state(ctx);
  const spanContext =
    state === undefined ? undefined : trace.getSpanContext(ctx);
  const now = millisToHrTime(Date.now());
  return copyLog(
    {
      hrTime: now,
      hrTimeObserved: now,
      ...(spanContext === undefined ? {} : { spanContext }),
      ...(input.severityNumber === undefined
        ? {}
        : { severityNumber: input.severityNumber }),
      ...(input.severityText === undefined
        ? {}
        : { severityText: input.severityText }),
      ...(input.eventName === undefined ? {} : { eventName: input.eventName }),
      resource: runtime.resource,
      instrumentationScope: scope,
      attributes: {
        ...(input.fields as LogAttributes),
        ...(input.errorType === undefined
          ? {}
          : { 'error.type': input.errorType }),
      },
      droppedAttributesCount: 0,
    },
    runtime,
  );
}
