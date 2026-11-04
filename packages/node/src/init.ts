import { createRequire, syncBuiltinESMExports } from 'node:module';
import { context, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { AlwaysOnSampler, TracerProvider } from '@opentelemetry/sdk-trace';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { createProcessors } from './index.js';
import { ConfigurationError, type NodeOptions } from './options.js';
import type { AgentrailNode } from './client.js';

let installed: { options: NodeOptions; client: AgentrailNode } | undefined;
/** Call before loading application HTTP modules. Use createProcessors when another OTel provider owns startup. */
export function init(options: NodeOptions): Promise<AgentrailNode> {
  if (installed !== undefined) {
    if (installed.options !== options)
      throw new ConfigurationError(
        'Agentrail is already initialized. Reuse the original options and client.',
      );
    return Promise.resolve(installed.client);
  }
  const sdk = createProcessors(options);
  const provider = new TracerProvider({
    sampler: sdk.sampler(new AlwaysOnSampler()),
    spanProcessors: [sdk.spanProcessor],
  });
  if (!trace.setGlobalTracerProvider(provider)) {
    void sdk.client.shutdown();
    throw new ConfigurationError(
      'A tracer provider is already installed. Wire createProcessors into its construction instead.',
    );
  }
  const manager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(manager)) {
    trace.disable();
    manager.disable();
    void provider.shutdown();
    throw new ConfigurationError(
      'An OTel context manager is already installed. Use createProcessors with the existing setup.',
    );
  }
  if (!propagation.setGlobalPropagator(sdk.propagator)) {
    trace.disable();
    context.disable();
    manager.disable();
    void provider.shutdown();
    throw new ConfigurationError(
      'An OTel propagator is already installed. Use createProcessors with the existing setup.',
    );
  }
  const logger = new LoggerProvider({ processors: [sdk.logProcessor] });
  const ownLogs = logs.setGlobalLoggerProvider(logger) === logger;
  if (!ownLogs) {
    trace.disable();
    context.disable();
    propagation.disable();
    manager.disable();
    void provider.shutdown();
    void logger.shutdown();
    throw new ConfigurationError(
      'A logger provider is already installed. Use createProcessors with the existing setup.',
    );
  }
  const http = new HttpInstrumentation(sdk.httpOptions);
  const undici = new UndiciInstrumentation(sdk.undiciOptions);
  http.setTracerProvider(provider);
  undici.setTracerProvider(provider);
  // Load core modules through the supported instrumentation loader, then refresh Node's ESM bindings.
  const require = createRequire(import.meta.url);
  require('node:http');
  require('node:https');
  syncBuiltinESMExports();
  let stopping: Promise<void> | undefined;
  const client: AgentrailNode = {
    ...sdk.client,
    shutdown() {
      stopping ??= (async () => {
        http.disable();
        undici.disable();
        await Promise.all([provider.shutdown(), logger.shutdown()]);
        manager.disable();
      })();
      return stopping;
    },
  };
  installed = { options, client };
  return Promise.resolve(client);
}
