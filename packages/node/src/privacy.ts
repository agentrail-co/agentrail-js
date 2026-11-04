import { randomUUID } from 'node:crypto';
import { trace, SpanKind } from '@opentelemetry/api';
import type { Attributes, Context, SpanContext } from '@opentelemetry/api';
import { millisToHrTime } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { LogAttributes, SeverityNumber } from '@opentelemetry/api-logs';
import type { Runtime } from './runtime.js';

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
  for (const marker of markers) url.searchParams.append('h', marker);
  return url.href;
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
  const entry =
    metadata.mark !== undefined ||
    span.kind === SpanKind.SERVER ||
    span.kind === SpanKind.CONSUMER;
  if (entry)
    Object.assign(attrs, metadata.mark?.identity ?? metadata.state.identity);
  if (span.kind === SpanKind.SERVER)
    attrs['agentrail.ingress.verified'] = metadata.state.verifiedIngress;
  if (metadata.mark !== undefined)
    Object.assign(attrs, {
      'agentrail.step': true,
      'agentrail.step.surface': metadata.mark.surface,
      'agentrail.step.kind': metadata.mark.kind,
    });
  const mcp = metadata.mark?.mcp;
  if (mcp !== undefined) {
    if (mcp.client !== undefined)
      attrs['agentrail.mcp.client.name'] = mcp.client;
    if (mcp.clientVersion !== undefined)
      attrs['agentrail.mcp.client.version'] = mcp.clientVersion;
    if (mcp.protocol !== undefined)
      attrs['agentrail.mcp.protocol.version'] = mcp.protocol;
  }
  const parent = span.parentSpanContext;
  return {
    name:
      metadata.mark?.name ??
      (typeof attrs['http.request.method'] === 'string'
        ? `HTTP ${attrs['http.request.method']}`
        : 'backend.operation'),
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
function selectedBody(
  fields: Readonly<Record<string, unknown>>,
  selected: readonly string[],
): string | undefined {
  const result: Record<string, string | number | boolean | null> = {};
  for (const field of selected) {
    const value = fields[field];
    if (typeof value === 'string') result[field] = boundedText(value, 4096);
    else if (
      typeof value === 'boolean' ||
      value === null ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      result[field] = value;
  }
  return Object.keys(result).length === 0
    ? undefined
    : JSON.stringify(result).slice(0, 4096);
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
      : { severityText: record.severityText.slice(0, 64) }),
    ...(record.eventName === undefined
      ? {}
      : { eventName: record.eventName.slice(0, 256) }),
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
