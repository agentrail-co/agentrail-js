import { isCaptureSuppressed } from './suppression.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { ExportQueue } from './queue.js';
import {
  copySpan,
  estimatedBytes,
  payloadBytes,
  withoutPayloads,
} from './privacy.js';
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
    { bytes: estimatedBytes, payloadBytes, withoutPayloads },
  );
  const logs = new ExportQueue(
    'logs',
    new OTLPLogExporter({ ...config, url: `${options.endpoint}/v1/logs` }),
    options,
  );
  /** On the SDK's own tracer provider only: no other span ever reaches it. */
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
  return { spanProcessor, spans, logs };
}
