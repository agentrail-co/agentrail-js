import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import type { ServerContext } from '@modelcontextprotocol/server';
import type { AgentrailNode } from './client.js';
import { boundedText } from './privacy.js';

export interface McpCaptureOptions {
  readonly client: AgentrailNode;
}
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
/** Wrap the callbacks passed to public registerTool/registerResource/registerPrompt APIs. No transport is patched. */
export function mcp(options: McpCaptureOptions) {
  function wrap<Args extends unknown[], Result>(
    method: string,
    name: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): (...args: Args) => Promise<Result> {
    return (...args) => {
      // All supported registration callbacks receive ServerContext as their final argument.
      const ctx = args.at(-1) as ServerContext;
      const envelope = record(ctx.mcpReq.envelope);
      const clientInfo = record(
        envelope?.['io.modelcontextprotocol/clientInfo'],
      );
      const protocol = boundedText(
        envelope?.['io.modelcontextprotocol/protocolVersion'] ??
          ctx.http?.req?.headers.get('mcp-protocol-version'),
        64,
      );
      const client = boundedText(clientInfo?.name, 128);
      const version = boundedText(clientInfo?.version, 128);
      return options.client.milestone(
        `mcp.${method}:${name}`.slice(0, 256),
        {
          surface: 'mcp',
          kind: method === 'tools/call' ? 'tool.call' : `mcp.${method}`,
          mcp: {
            method,
            ...(client === undefined ? {} : { client }),
            ...(version === undefined ? {} : { clientVersion: version }),
            ...(protocol === undefined ? {} : { protocol }),
          },
        },
        async () => {
          const result = await handler(...args);
          if (record(result)?.isError === true) {
            const span = trace.getSpan(context.active());
            span?.setStatus({ code: SpanStatusCode.ERROR });
            span?.setAttribute('error.type', 'McpOperationError');
          }
          return result;
        },
      );
    };
  }
  return {
    tool: <Args extends unknown[], Result>(
      name: string,
      handler: (...args: Args) => Result | Promise<Result>,
    ) => wrap('tools/call', name, handler),
    resource: <Args extends unknown[], Result>(
      name: string,
      handler: (...args: Args) => Result | Promise<Result>,
    ) => wrap('resources/read', name, handler),
    prompt: <Args extends unknown[], Result>(
      name: string,
      handler: (...args: Args) => Result | Promise<Result>,
    ) => wrap('prompts/get', name, handler),
  };
}
