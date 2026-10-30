import type { SpanContext } from './event.js';

/**
 * W3C trace context (`traceparent`), which every component speaks with
 * OpenTelemetry's field names, without the OpenTelemetry SDK.
 */

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/u;
const INVALID_TRACE = '0'.repeat(32);
const INVALID_SPAN = '0'.repeat(16);

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function newTraceId(): string {
  return hex(16);
}

export function newSpanId(): string {
  return hex(8);
}

/** The context a `traceparent` header names, or null when it names none validly. */
export function parseTraceparent(header: string | null): SpanContext | null {
  const match = header === null ? null : TRACEPARENT.exec(header.trim());
  const traceId = match?.[1];
  const spanId = match?.[2];
  if (traceId === undefined || spanId === undefined) return null;
  if (traceId === INVALID_TRACE || spanId === INVALID_SPAN) return null;
  return { traceId, spanId };
}

/** A sampled `traceparent` naming this span as the parent. */
export function formatTraceparent(context: SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}
