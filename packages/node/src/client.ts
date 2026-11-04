import {
  context,
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
} from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import {
  CaptureError,
  ConfigurationError,
  type MilestoneContext,
  type VerifiedIdentity,
} from './options.js';
import { makeLog, type StructuredLog } from './privacy.js';
import type { processors } from './processors.js';
import type { Runtime } from './runtime.js';

export interface AgentrailNode {
  identify(identity: VerifiedIdentity): void;
  milestone(name: string, details: MilestoneContext): void;
  milestone<T>(
    name: string,
    details: MilestoneContext,
    run: () => T | Promise<T>,
  ): Promise<T>;
  log(input: StructuredLog): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
  diagnostics(): {
    spans: import('./queue.js').QueueStats;
    logs: import('./queue.js').QueueStats;
  };
}
export function createClient(
  runtime: Runtime,
  queues: ReturnType<typeof processors>,
): AgentrailNode {
  function parent(): Context {
    const active = context.active();
    if (runtime.state(active) !== undefined) return active;
    const external = trace.getSpanContext(active);
    return ROOT_CONTEXT.setValue(
      runtime.stateKey,
      runtime.newState(
        false,
        external === undefined ? [] : [{ context: external }],
      ),
    );
  }
  function start(
    name: string,
    details: MilestoneContext,
    identity?: import('@opentelemetry/api').Attributes,
  ) {
    if (
      name.length === 0 ||
      name.length > 256 ||
      details.kind.length === 0 ||
      details.kind.length > 256
    )
      throw new ConfigurationError(
        'Milestone name and kind must contain 1–256 characters.',
      );
    const base = parent();
    const marked = base.setValue(runtime.markKey, {
      ...details,
      name,
      ...(identity === undefined ? {} : { identity }),
    });
    const state = runtime.state(base);
    const span = trace.getTracer('agentrail-node').startSpan(
      name,
      {
        links:
          trace.getSpanContext(base) === undefined ? (state?.links ?? []) : [],
      },
      marked,
    );
    if (!span.isRecording())
      runtime.options.report(
        new CaptureError('entry_not_recording', 'traces', 1),
      );
    return { span, ctx: trace.setSpan(base, span) };
  }
  function milestone(name: string, details: MilestoneContext): void;
  function milestone<T>(
    name: string,
    details: MilestoneContext,
    run: () => T | Promise<T>,
  ): Promise<T>;
  function milestone<T>(
    name: string,
    details: MilestoneContext,
    run?: () => T | Promise<T>,
  ): void | Promise<T> {
    const { span, ctx } = start(name, details);
    if (run === undefined) {
      span.end();
      return;
    }
    return context.with(ctx, async () => {
      try {
        return await run();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
  return {
    identify(identity) {
      if (identity.id.length === 0 || identity.actingUserId === '')
        throw new ConfigurationError('Verified identity IDs cannot be empty.');
      const state = runtime.state(context.active());
      if (state === undefined) {
        runtime.options.report(
          new CaptureError('identity_outside_request', 'context', 1),
        );
        return;
      }
      const hashed = runtime.identity(identity);
      if (state.identity === undefined) state.identity = hashed;
      else if (JSON.stringify(state.identity) !== JSON.stringify(hashed)) {
        // Preserve the first assertion; contradictory assertions are explicit evidence.
        const { span } = start(
          'identity.asserted',
          { surface: 'auth', kind: 'auth.identity' },
          hashed,
        );
        span.end();
      }
    },
    milestone,
    log(input) {
      const record = makeLog(input, context.active(), runtime);
      if (record !== undefined) queues.logs.add(record);
    },
    async flush() {
      await Promise.all([queues.spans.flush(), queues.logs.flush()]);
    },
    async shutdown() {
      await Promise.all([queues.spans.shutdown(), queues.logs.shutdown()]);
    },
    diagnostics: () => ({
      spans: queues.spans.diagnostics(),
      logs: queues.logs.diagnostics(),
    }),
  };
}
