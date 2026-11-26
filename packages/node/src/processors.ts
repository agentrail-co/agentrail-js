import { isCaptureSuppressed } from './suppression.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import {
  createOtlpHttpExportDelegate,
  httpAgentFactoryFromOptions,
} from '@opentelemetry/otlp-exporter-base/node-http';
import {
  LogsExporterMetricsHelper,
  ProtobufLogsSerializer,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from '@opentelemetry/otlp-transformer';
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
  /**
   * OTLP/HTTP protobuf to the collector, configured in full: the exporters'
   * own constructors merge the application's OTEL_EXPORTER_OTLP_* settings
   * in (its headers, a vendor's key among them, compression, certificates),
   * and none of them is Agentrail's to send. The same transport, with its
   * retries, as those exporters use.
   */
  const configuration = (path: string) => ({
    url: new URL(`${options.endpoint}/${path}`).href,
    headers: () =>
      Promise.resolve({
        Authorization: `Bearer ${options.input.collector.secret}`,
        'Content-Type': 'application/x-protobuf',
      }),
    compression: 'none' as const,
    timeoutMillis: options.queue.exportTimeoutMs,
    concurrencyLimit: 30,
    agentFactory: httpAgentFactoryFromOptions({ keepAlive: true }),
  });
  const spans = new ExportQueue(
    'traces',
    new OTLPExporterBase(
      createOtlpHttpExportDelegate(
        configuration('v1/traces'),
        ProtobufTraceSerializer,
        'otlp_http_span_exporter',
        TraceExporterMetricsHelper,
        // Its own metrics go nowhere, never to the application's meters.
        undefined,
      ),
    ),
    options,
    { bytes: estimatedBytes, payloadBytes, withoutPayloads },
  );
  const logs = new ExportQueue(
    'logs',
    new OTLPExporterBase(
      createOtlpHttpExportDelegate(
        configuration('v1/logs'),
        ProtobufLogsSerializer,
        'otlp_http_log_exporter',
        LogsExporterMetricsHelper,
        // Its own metrics go nowhere, never to the application's meters.
        undefined,
      ),
    ),
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
