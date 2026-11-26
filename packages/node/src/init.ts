import { createRequire } from 'node:module';
import { ConfigurationError, type NodeOptions } from './options.js';
import type { AgentrailNode } from './client.js';
import { installHttpCapture } from './http.js';
import { internalOf, registerInternal } from './runtime.js';
import { createSdk } from './sdk.js';

let installed: { options: NodeOptions; client: AgentrailNode } | undefined;
/**
 * Call before loading application HTTP modules. Once per process: a second
 * installation would record every request twice. Sentry, Datadog or an
 * OpenTelemetry setup can start before or after it; it registers no
 * OpenTelemetry global and leaves theirs alone.
 */
export function init(options: NodeOptions): Promise<AgentrailNode> {
  if (installed !== undefined) {
    if (installed.options !== options)
      throw new ConfigurationError(
        'Agentrail is already initialized. Reuse the original options and client.',
      );
    return Promise.resolve(installed.client);
  }
  const sdk = createSdk(options);
  // Let an instrumentation that patches on require (Datadog's, say) patch
  // node:http first, so this SDK's wrappers sit outside it.
  const require = createRequire(import.meta.url);
  require('node:http');
  require('node:https');
  const uninstall = installHttpCapture(sdk.runtime, sdk.tracer);
  let stopping: Promise<void> | undefined;
  const client: AgentrailNode = {
    ...sdk.client,
    shutdown() {
      stopping ??= (async () => {
        uninstall();
        await sdk.client.shutdown();
      })();
      return stopping;
    },
  };
  // The MCP adapter finds the runtime through the client it is given.
  registerInternal(client, internalOf(sdk.client));
  installed = { options, client };
  return Promise.resolve(client);
}
