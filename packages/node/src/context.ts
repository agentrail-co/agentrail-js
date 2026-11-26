import { AsyncLocalStorage } from 'node:async_hooks';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';

const storage = new AsyncLocalStorage<Context>();
/**
 * Agentrail's own current context: a request's state, a milestone and the
 * span they run under, in a slot only this SDK reads. The application's
 * OpenTelemetry context, its current span and its context manager are never
 * read or written for them, so Sentry, Datadog or an OpenTelemetry setup can
 * run beside it, started before or after, and neither sees the other's work.
 */
export const ours = {
  active(): Context {
    return storage.getStore() ?? ROOT_CONTEXT;
  },
  with<A extends unknown[], R>(
    ctx: Context,
    run: (...args: A) => R,
    ...args: A
  ): R {
    return storage.run(ctx, run, ...args);
  },
  /** For the rest of this execution and what it starts, as a request's own handler sees it. */
  enterWith(ctx: Context): void {
    storage.enterWith(ctx);
  },
};
