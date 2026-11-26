import { createContextKey } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';
import { ours } from './context.js';

// Shared by installations in this process; never derived from a request or baggage.
const diagnostic = createContextKey('agentrail.capture.suppressed');
/** True inside `onError`, whatever context a span or log is given there. */
export function isCaptureSuppressed(ctx: Context): boolean {
  return (
    ours.active().getValue(diagnostic) === true ||
    ctx.getValue(diagnostic) === true
  );
}
/** What `onError` does (a log, a request) is never captured as the application's own work. */
export function reportWithoutCapture(run: () => void): void {
  ours.with(suppressTracing(ours.active()).setValue(diagnostic, true), run);
}
