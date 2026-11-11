import { resolveOptions, type NodeOptions } from './options.js';
import { Runtime } from './runtime.js';
import { processors } from './processors.js';
import { createClient } from './client.js';
import { httpCapture } from './http.js';

export {
  CaptureError,
  ConfigurationError,
  type NodeOptions,
  type VerifiedIdentity,
  type MilestoneContext,
  type PerformanceContext,
  type AuthorizedOperation,
  type PluginInvocation,
  type QueueOptions,
} from './options.js';
export type { AgentrailNode } from './client.js';
export type { StructuredLog } from './privacy.js';
export { init } from './init.js';

/** Construct before the application's provider. This factory never registers globals. */
export function createProcessors(options: NodeOptions) {
  const runtime = new Runtime(resolveOptions(options));
  const queues = processors(runtime);
  const http = httpCapture(runtime);
  const underlying = queues.spanProcessor.onStart.bind(queues.spanProcessor);
  queues.spanProcessor.onStart = (span, ctx) => {
    underlying(span, ctx);
    http.rememberPort(span, span.attributes['agentrail.network.port']);
  };
  return {
    client: createClient(runtime, queues),
    spanProcessor: queues.spanProcessor,
    logProcessor: queues.logProcessor,
    sampler: queues.sampler,
    propagator: http.propagator,
    httpOptions: http.httpOptions,
    undiciOptions: http.undiciOptions,
  };
}
export type AgentrailProcessors = ReturnType<typeof createProcessors>;
