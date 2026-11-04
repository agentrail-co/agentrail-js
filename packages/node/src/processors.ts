import { isCaptureSuppressed } from './suppression.js';
import { context } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace';
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace';
import type { LogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { ExportQueue } from './queue.js';
import { copyLog, copySpan } from './privacy.js';
import type { Runtime } from './runtime.js';

export function processors(runtime: Runtime) {
  const options = runtime.options;
  const config = {
    headers: { Authorization: `Bearer ${options.input.collector.secret}` },
    timeoutMillis: options.queue.exportTimeoutMs,
  };
  const spans = new ExportQueue(
    'traces',
    new OTLPTraceExporter({ ...config, url: `${options.endpoint}/v1/traces` }),
    options,
  );
  const logs = new ExportQueue(
    'logs',
    new OTLPLogExporter({ ...config, url: `${options.endpoint}/v1/logs` }),
    options,
  );
  const spanProcessor: SpanProcessor = {
    onStart(span, parent) {
      if (isCaptureSuppressed(parent)) return;
      const state = runtime.state(parent);
      if (state === undefined) return;
      const mark = runtime.mark(parent);
      runtime.spans.set(span, {
        state,
        ...(mark === undefined ? {} : { mark }),
      });
      state.entry.span ??= span;
    },
    onEnd(span) {
      const copy = copySpan(span, runtime);
      if (copy !== undefined) spans.add(copy);
    },
    forceFlush: () => spans.flush(),
    shutdown: () => spans.shutdown(),
  };
  const logProcessor: LogRecordProcessor = {
    onEmit(record, ctx = context.active()) {
      if (isCaptureSuppressed(ctx)) return;
      // An unrelated request's log must never inherit a managed request's context.
      if (
        runtime.state(ctx) === undefined &&
        options.input.logs?.uncorrelated === false
      )
        return;
      const copy = copyLog(record, runtime);
      if (copy !== undefined) logs.add(copy);
    },
    forceFlush: () => logs.flush(),
    shutdown: () => logs.shutdown(),
  };
  const sampler = (base: Sampler): Sampler => ({
    shouldSample(ctx, traceId, name, kind, attributes, links) {
      const result = base.shouldSample(
        ctx,
        traceId,
        name,
        kind,
        attributes,
        links,
      );
      return result.decision === SamplingDecision.NOT_RECORD &&
        runtime.state(ctx) !== undefined
        ? { ...result, decision: SamplingDecision.RECORD }
        : result;
    },
    toString: () => `Agentrail(${base.toString()})`,
  });
  return { spanProcessor, logProcessor, sampler, spans, logs };
}
