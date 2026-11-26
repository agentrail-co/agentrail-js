import { AlwaysOnSampler, TracerProvider } from '@opentelemetry/sdk-trace';
import { createClient } from './client.js';
import { resolveOptions, type NodeOptions } from './options.js';
import { processors } from './processors.js';
import { Runtime } from './runtime.js';

/**
 * The client and the SDK's own tracer, on a tracer provider only this SDK
 * uses: no OpenTelemetry global is read or registered, so the application's
 * tracing, sampling and exporters stay exactly as they were.
 */
export function createSdk(options: NodeOptions) {
  const runtime = new Runtime(resolveOptions(options));
  const queues = processors(runtime);
  const provider = new TracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [queues.spanProcessor],
    // Stated, never left to an environment: an MCP payload attribute holds
    // up to 14 MiB, and every value is sent whole.
    spanLimits: {
      attributeCountLimit: 128,
      attributeValueLengthLimit: Infinity,
      eventCountLimit: 128,
      linkCountLimit: 128,
      attributePerEventCountLimit: 128,
      attributePerLinkCountLimit: 128,
    },
  });
  const tracer = provider.getTracer('agentrail-node');
  return { runtime, tracer, client: createClient(runtime, queues, tracer) };
}
