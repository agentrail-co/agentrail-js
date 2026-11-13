import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import {
  McpServer,
  createMcpHandler,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createProcessors } from '../src/index.js';
import { mcp } from '../src/mcp.js';
import { collector, attributesOf } from './support/collector.js';
import { options } from './support/options.js';

// Fails if MCP metadata becomes verified identity, request contexts mix, or arguments/results are exported.
describe('MCP 2.3 request callbacks', () => {
  it('captures real protocol calls and keeps self-reported client metadata separate from identity', async () => {
    const sink = await collector();
    const sdk = createProcessors(options(sink.endpoint));
    const provider = new TracerProvider({
      sampler: sdk.sampler({
        shouldSample: () => ({ decision: 2 }),
        toString: () => 'always',
      }),
      spanProcessors: [sdk.spanProcessor],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(manager)).toBe(true);
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const handler = createMcpHandler(
      () => {
        const server = new McpServer({
          name: 'synthetic-server',
          version: '1',
        });
        const capture = mcp({ client: sdk.client });
        const tool: ToolCallback = async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 2);
          });
          sdk.client.log({
            severityNumber: 17,
            errorType: 'SyntheticToolFailure',
          });
          return {
            isError: true,
            content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_RESULT' }],
          };
        };
        server.registerTool(
          'synthetic_tool',
          {},
          capture.tool('synthetic_tool', tool),
        );
        server.registerResource(
          'synthetic_resource',
          'synthetic://resource',
          {},
          capture.resource('synthetic_resource', () => ({
            contents: [
              { uri: 'synthetic://resource', text: 'SYNTHETIC_PRIVATE_RESULT' },
            ],
          })),
        );
        server.registerPrompt(
          'synthetic_prompt',
          {},
          capture.prompt('synthetic_prompt', () => ({
            messages: [
              {
                role: 'user',
                content: { type: 'text', text: 'SYNTHETIC_PRIVATE_RESULT' },
              },
            ],
          })),
        );
        return server;
      },
      { responseMode: 'json', legacy: 'stateless' },
    );
    async function call(
      clientName: string,
      verified: boolean,
      method = 'tools/call',
    ) {
      return sdk.client.milestone(
        'http.request',
        { surface: 'http', kind: 'http.request' },
        async () => {
          if (verified)
            sdk.client.identify({
              kind: 'agent_registration',
              id: 'synthetic-verified-agent',
            });
          const params =
            method === 'tools/call'
              ? {
                  name: 'synthetic_tool',
                  arguments: { private: 'SYNTHETIC_PRIVATE_ARGUMENT' },
                }
              : method === 'resources/read'
                ? { uri: 'synthetic://resource' }
                : { name: 'synthetic_prompt' };
          const request = new Request('http://synthetic.test/mcp', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2026-07-28',
              'mcp-method': method,
              ...(method === 'resources/read'
                ? { 'mcp-name': 'synthetic://resource' }
                : {
                    'mcp-name':
                      method === 'tools/call'
                        ? 'synthetic_tool'
                        : 'synthetic_prompt',
                  }),
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method,
              params: {
                ...params,
                _meta: {
                  [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
                  [CLIENT_INFO_META_KEY]: { name: clientName, version: '1' },
                  [CLIENT_CAPABILITIES_META_KEY]: {},
                  traceparent:
                    '00-11111111111111111111111111111111-2222222222222222-01',
                  'agentrail.identity.verified': true,
                },
              },
            }),
          });
          const response = await handler.fetch(request);
          const body = await response.text();
          expect(response.status, body).toBe(200);
          expect(body).toContain('SYNTHETIC_PRIVATE_RESULT');
        },
      );
    }
    try {
      const results = await Promise.allSettled([
        call('first-client', true),
        call('forged-agent', false),
        call('resource-client', false, 'resources/read'),
        call('prompt-client', false, 'prompts/get'),
      ]);
      for (const result of results)
        if (result.status === 'rejected') throw result.reason;
      await sdk.client.flush();
      const steps = sink
        .spans()
        .filter(
          (span) =>
            attributesOf(span.attributes)['agentrail.step.surface'] === 'mcp',
        );
      expect(steps).toHaveLength(4);
      expect(steps.map((span) => span.name).sort()).toEqual([
        'mcp.prompts/get:synthetic_prompt',
        'mcp.resources/read:synthetic_resource',
        'mcp.tools/call:synthetic_tool',
        'mcp.tools/call:synthetic_tool',
      ]);
      const verified = steps.find(
        (span) =>
          attributesOf(span.attributes)['agentrail.mcp.client.name'] ===
          'first-client',
      );
      expect(
        attributesOf(verified?.attributes)['agentrail.identity.verified'],
      ).toBe(true);
      const forged = steps.find(
        (span) =>
          attributesOf(span.attributes)['agentrail.mcp.client.name'] ===
          'forged-agent',
      );
      expect(forged).toBeDefined();
      expect(
        attributesOf(forged?.attributes)['agentrail.identity.verified'],
      ).toBeUndefined();
      expect(
        steps.every(
          (span) =>
            attributesOf(span.attributes)['agentrail.mcp.protocol.version'] ===
            '2026-07-28',
        ),
      ).toBe(true);
      // Fails if the OpenTelemetry MCP names are dropped, a resource is
      // named by its URI, or a failed tool result reads as a thrown handler.
      const named = (method: string) =>
        attributesOf(
          steps.find(
            (span) =>
              attributesOf(span.attributes)['mcp.method.name'] === method,
          )?.attributes,
        );
      expect(named('tools/call')).toMatchObject({
        'gen_ai.tool.name': 'synthetic_tool',
        'error.type': 'tool_error',
      });
      expect(named('prompts/get')['gen_ai.prompt.name']).toBe(
        'synthetic_prompt',
      );
      const resource = named('resources/read');
      for (const key of [
        'gen_ai.tool.name',
        'gen_ai.prompt.name',
        'mcp.resource.uri',
      ])
        expect(resource[key]).toBeUndefined();
      expect(sink.logs()).toHaveLength(2);
      expect(
        sink
          .logs()
          .every((log) =>
            steps.some((step) => log.spanId?.equals(step.spanId)),
          ),
      ).toBe(true);
      const bytes = Buffer.concat(
        sink.packets.map((packet) => packet.bytes),
      ).toString();
      expect(bytes).not.toContain('SYNTHETIC_PRIVATE');
      expect(bytes).not.toContain('synthetic-verified-agent');
      expect(
        sink
          .spans()
          .every(
            (span) =>
              Buffer.from(span.traceId).toString('hex') !== '1'.repeat(32),
          ),
      ).toBe(true);
      const legacy = new Client(
        { name: 'legacy-client', version: '1' },
        { versionNegotiation: { mode: 'legacy' } },
      );
      try {
        await legacy.connect(
          new StreamableHTTPClientTransport(
            new URL('http://synthetic.test/mcp'),
            {
              fetch: (url, init) =>
                sdk.client.milestone(
                  'legacy.http',
                  { surface: 'http', kind: 'http.request' },
                  () => handler.fetch(new Request(url, init)),
                ),
            },
          ),
        );
        const result = await legacy.callTool({
          name: 'synthetic_tool',
          arguments: {},
        });
        expect(JSON.stringify(result)).toContain('SYNTHETIC_PRIVATE_RESULT');
        await sdk.client.flush();
        expect(
          sink
            .spans()
            .some(
              (span) =>
                attributesOf(span.attributes)[
                  'agentrail.mcp.protocol.version'
                ] === '2025-11-25',
            ),
        ).toBe(true);
      } finally {
        await legacy.close();
      }
    } finally {
      await handler.close();
      await sdk.client.shutdown();
      await provider.shutdown();
      manager.disable();
      context.disable();
      trace.disable();
      await sink.close();
    }
  });
});
