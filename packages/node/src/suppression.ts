import { AsyncLocalStorage } from 'node:async_hooks';
import { context, createContextKey } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import { suppressTracing } from '@opentelemetry/core';

// Shared by installations in this process; never derived from a request or baggage.
const diagnostic = createContextKey('agentrail.capture.suppressed');
const reporting = new AsyncLocalStorage<boolean>();
export function isCaptureSuppressed(ctx: Context): boolean {
  return reporting.getStore() === true || ctx.getValue(diagnostic) === true;
}
export function reportWithoutCapture(run: () => void): void {
  reporting.run(true, () => {
    context.with(
      suppressTracing(context.active()).setValue(diagnostic, true),
      run,
    );
  });
}
