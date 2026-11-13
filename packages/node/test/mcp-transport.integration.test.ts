import { createHmac, randomUUID } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { context, trace } from '@opentelemetry/api';
import { TracerProvider } from '@opentelemetry/sdk-trace';
import { OTLP, type McpCallFacts } from 'agentrail-contract';
import { describe, expect, it, vi } from 'vitest';
import { createProcessors, type CaptureError } from '../src/index.js';
import { mcp, type McpPayloadCapture } from '../src/mcp.js';
import { collector, attributesOf, type WireSpan } from './support/collector.js';
import { HASH_KEY, options } from './support/options.js';

const A = OTLP.mcpAttributes;
const url = new URL('http://synthetic.test/mcp');

interface FixtureSpan {
  readonly name: string;
  readonly parentSpanId?: string;
  readonly attributes?: readonly { readonly key: string }[];
}
function fixture(name: string) {
  const found = OTLP.fixtures.accepted.find((item) => item.name === name);
  if (found === undefined) throw new Error(`No contract fixture ${name}.`);
  const request = found.request as {
    resourceSpans: { scopeSpans: { spans: FixtureSpan[] }[] }[];
  };
  const spans = request.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
  return {
    expected: found.expected,
    keys: (span: FixtureSpan | undefined) =>
      (span?.attributes ?? []).map((attribute) => attribute.key).sort(),
    transport: spans.find((span) => span.parentSpanId === undefined),
    handler: spans.find((span) => span.parentSpanId !== undefined),
  };
}
/** Every attribute name the contract names, in its tables or its fixtures. */
const named = new Set([
  ...Object.values(OTLP.spanAttributes),
  ...Object.values(OTLP.mcpAttributes),
  ...OTLP.fixtures.accepted.flatMap((item) =>
    item.signal === 'traces'
      ? (
          item.request as {
            resourceSpans: { scopeSpans: { spans: FixtureSpan[] }[] }[];
          }
        ).resourceSpans.flatMap((resource) =>
          resource.scopeSpans.flatMap((scope) =>
            scope.spans.flatMap((span) =>
              (span.attributes ?? []).map((attribute) => attribute.key),
            ),
          ),
        )
      : [],
  ),
]);
/** What the collector reads of an MCP span, as the contract's `expected.mcp` gives it. */
function facts(span: WireSpan): McpCallFacts {
  const attributes = attributesOf(span.attributes);
  return {
    layer: attributes[A.layer] as McpCallFacts['layer'],
    method: attributes[A.method] as string,
    errorCode: (attributes[A.errorCode] as number | undefined) ?? null,
    isError: (attributes[A.isError] as boolean | undefined) ?? null,
    requestBytes: (attributes[A.requestBytes] as number | undefined) ?? null,
    responseBytes: (attributes[A.responseBytes] as number | undefined) ?? null,
  };
}
const keysOf = (span: WireSpan | undefined) =>
  (span?.attributes ?? []).map((attribute) => attribute.key).sort();
const hashOf = (id: string) =>
  createHmac('sha256', HASH_KEY).update(id).digest('hex').slice(0, 32);

async function harness(
  capturePayloads?: McpPayloadCapture,
  queue: Partial<ReturnType<typeof options>['queue']> = {},
) {
  const sink = await collector();
  const failures: CaptureError[] = [];
  const base = options(sink.endpoint);
  const sdk = createProcessors({
    ...base,
    queue: { ...base.queue, ...queue },
    onError: (error) => {
      failures.push(error);
    },
  });
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
  const capture = mcp({
    client: sdk.client,
    ...(capturePayloads === undefined ? {} : { capturePayloads }),
  });
  const mcpSpans = () =>
    sink
      .spans()
      .filter((span) => attributesOf(span.attributes)[A.layer] !== undefined);
  return {
    sink,
    sdk,
    capture,
    failures,
    mcpSpans,
    transportSpans: () =>
      mcpSpans().filter(
        (span) => attributesOf(span.attributes)[A.layer] === 'transport',
      ),
    async close() {
      await sdk.client.shutdown();
      await provider.shutdown();
      manager.disable();
      context.disable();
      trace.disable();
      await sink.close();
    },
  };
}
function server(
  capture: ReturnType<typeof mcp>,
  result = 'SYNTHETIC_PRIVATE_RESULT',
) {
  const server = new McpServer({ name: 'synthetic-server', version: '1' });
  server.registerTool(
    'synthetic_tool',
    {},
    capture.tool('synthetic_tool', () => ({
      content: [{ type: 'text', text: result }],
    })),
  );
  server.registerTool(
    'failing_tool',
    {},
    capture.tool('failing_tool', () => ({
      isError: true,
      content: [{ type: 'text', text: 'synthetic failure' }],
    })),
  );
  return server;
}
const legacy = () =>
  new Client(
    { name: 'synthetic-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' } },
  );

describe('MCP transport capture', () => {
  // Fails if someone counts a tool call twice (transport and handler both
  // steps), drops the session hash of a transport that has a session, loses
  // a JSON-RPC error code, misses a message the server received, or emits an
  // attribute the contract does not name.
  it('records one step per message a stateful transport receives, with its handler as a child, as the contract fixtures give them', async () => {
    const h = await harness();
    try {
      const inner = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const transport = h.capture.transport(inner);
      await server(h.capture).connect(transport);
      const client = legacy();
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          // The wrapper still serves the transport's own methods.
          fetch: (input, init) =>
            transport.handleRequest(new Request(input, init)),
        }),
      );
      const session = inner.sessionId;
      if (session === undefined) throw new Error('No MCP session.');
      await client.listTools();
      const answered = await client.callTool({
        name: 'synthetic_tool',
        arguments: { private: 'SYNTHETIC_PRIVATE_ARGUMENT' },
      });
      expect(JSON.stringify(answered)).toContain('SYNTHETIC_PRIVATE_RESULT');
      await client.callTool({ name: 'failing_tool', arguments: {} });
      await expect(
        client.callTool({ name: 'missing_tool', arguments: {} }),
      ).rejects.toThrow('missing_tool');
      await client.close();
      await h.sdk.client.flush();

      const transports = h.transportSpans();
      expect(transports.map((span) => span.name).sort()).toEqual([
        'mcp.initialize',
        'mcp.notifications/initialized',
        'mcp.tools/call:failing_tool',
        'mcp.tools/call:missing_tool',
        'mcp.tools/call:synthetic_tool',
        'mcp.tools/list',
      ]);
      const steps = h.sink
        .spans()
        .filter(
          (span) =>
            attributesOf(span.attributes)[OTLP.spanAttributes.explicitStep] ===
            true,
        );
      expect(steps.map((span) => span.name).sort()).toEqual(
        transports.map((span) => span.name).sort(),
      );
      expect(
        transports.every(
          (span) =>
            attributesOf(span.attributes)[A.sessionHash] === hashOf(session),
        ),
      ).toBe(true);
      expect(hashOf(session)).toMatch(/^[0-9a-f]{32}$/u);

      const byName = (name: string, layer: string) =>
        h
          .mcpSpans()
          .find(
            (span) =>
              span.name === name &&
              attributesOf(span.attributes)[A.layer] === layer,
          );
      const ok = byName('mcp.tools/call:synthetic_tool', 'transport');
      const okHandler = byName('mcp.tools/call:synthetic_tool', 'handler');
      const withHandler = fixture('sdk-mcp-transport-with-handler');
      expect(keysOf(ok)).toEqual(withHandler.keys(withHandler.transport));
      expect(keysOf(okHandler)).toEqual(withHandler.keys(withHandler.handler));
      expect(
        okHandler?.parentSpanId?.equals(ok?.spanId ?? Buffer.alloc(0)),
      ).toBe(true);
      expect(ok === undefined ? undefined : facts(ok)).toEqual({
        ...withHandler.expected.mcp?.[0],
        requestBytes: expect.any(Number) as number,
        responseBytes: expect.any(Number) as number,
      });
      expect(attributesOf(ok?.attributes)).toMatchObject({
        [A.clientName]: 'synthetic-client',
        [A.clientVersion]: '1.0.0',
        [A.protocolVersion]: '2025-11-25',
      });

      const missing = byName('mcp.tools/call:missing_tool', 'transport');
      const jsonRpcError = fixture('sdk-mcp-jsonrpc-error');
      expect(keysOf(missing)).toEqual(
        jsonRpcError.keys(jsonRpcError.transport),
      );
      expect(missing?.status?.code).toBe(2);
      expect(attributesOf(missing?.attributes)['error.type']).toBe(
        'McpJsonRpcError',
      );
      expect(missing === undefined ? undefined : facts(missing)).toEqual({
        ...jsonRpcError.expected.mcp?.[0],
        errorCode: -32602,
        requestBytes: expect.any(Number) as number,
        responseBytes: expect.any(Number) as number,
      });

      const failing = byName('mcp.tools/call:failing_tool', 'transport');
      const toolError = fixture('sdk-mcp-tool-error-with-payload');
      expect(keysOf(failing)).toEqual(
        toolError
          .keys(toolError.transport)
          .filter(
            (key) =>
              ![
                A.requestPayload,
                A.responsePayload,
                A.requestTruncated,
                A.responseTruncated,
              ].includes(key),
          ),
      );
      expect(failing === undefined ? undefined : facts(failing)).toEqual({
        ...toolError.expected.mcp?.[0],
        requestBytes: expect.any(Number) as number,
        responseBytes: expect.any(Number) as number,
      });
      expect(attributesOf(failing?.attributes)['error.type']).toBe(
        'McpOperationError',
      );

      const initialized = byName('mcp.notifications/initialized', 'transport');
      expect(attributesOf(initialized?.attributes)).toMatchObject({
        [OTLP.spanAttributes.stepKind]: 'mcp.notifications/initialized',
        [A.requestBytes]: expect.any(Number) as number,
      });
      expect(attributesOf(initialized?.attributes)[A.responseBytes]).toBe(
        undefined,
      );
      for (const span of h.mcpSpans())
        for (const key of keysOf(span)) expect(named).toContain(key);
      const bytes = Buffer.concat(
        h.sink.packets.map((packet) => packet.bytes),
      ).toString();
      expect(bytes).not.toContain('SYNTHETIC_PRIVATE');
      expect(bytes).not.toContain(session);
    } finally {
      await h.close();
    }
  });

  // Fails if someone exports payloads with capturePayloads off, still exports
  // when redact returns null, sends the unredacted call, or lets a throwing
  // redact break the call or go unreported.
  it.each([
    ['off', undefined],
    ['null', () => null],
    [
      'redacted',
      ({ request }: { request: unknown }) => ({
        request: { ...(request as object), arguments: { q: '[redacted]' } },
        response: { content: [{ type: 'text', text: 'synthetic result' }] },
      }),
    ],
    [
      'throwing',
      () => {
        throw new Error('Synthetic redact failure.');
      },
    ],
  ] as const)(
    'sends payloads only as redact returns them (%s)',
    async (variant, redact) => {
      const calls: unknown[] = [];
      const h = await harness(
        redact === undefined
          ? undefined
          : {
              redact: (payload) => {
                calls.push(payload);
                return redact(payload);
              },
            },
      );
      try {
        const [client, served] = InMemoryTransport.createLinkedPair();
        await server(h.capture).connect(h.capture.transport(served));
        const agent = legacy();
        await agent.connect(client);
        const result = await agent.callTool({
          name: 'synthetic_tool',
          arguments: { private: 'SYNTHETIC_PRIVATE_ARGUMENT' },
        });
        expect(JSON.stringify(result)).toContain('SYNTHETIC_PRIVATE_RESULT');
        await agent.close();
        await h.sdk.client.flush();
        const call = h
          .transportSpans()
          .find((span) => span.name === 'mcp.tools/call:synthetic_tool');
        const attributes = attributesOf(call?.attributes);
        const bytes = Buffer.concat(
          h.sink.packets.map((packet) => packet.bytes),
        ).toString();
        expect(bytes).not.toContain('SYNTHETIC_PRIVATE');
        if (variant === 'redacted') {
          expect(attributes[A.requestPayload]).toBe(
            '{"name":"synthetic_tool","arguments":{"q":"[redacted]"}}',
          );
          expect(attributes[A.responsePayload]).toBe(
            '{"content":[{"type":"text","text":"synthetic result"}]}',
          );
          expect(calls).toContainEqual({
            method: 'tools/call',
            name: 'synthetic_tool',
            request: {
              name: 'synthetic_tool',
              arguments: { private: 'SYNTHETIC_PRIVATE_ARGUMENT' },
            },
            response: {
              content: [{ type: 'text', text: 'SYNTHETIC_PRIVATE_RESULT' }],
            },
          });
        } else {
          expect(attributes[A.requestPayload]).toBeUndefined();
          expect(attributes[A.responsePayload]).toBeUndefined();
        }
        expect(calls.length > 0).toBe(variant !== 'off');
        expect(h.failures.map((error) => error.code)).toEqual(
          variant === 'throwing'
            ? calls.map(() => 'payload_redact_failed')
            : [],
        );
      } finally {
        await h.close();
      }
    },
  );

  // Fails if someone lets a result over the export limit fail the export
  // (the whole batch would be lost) instead of truncating its payload, or
  // cuts the text through a character the collector would refuse.
  it('truncates a payload too large for one export, well-formed, and still exports the span', async () => {
    const h = await harness(
      { redact: ({ request, response }) => ({ request, response }) },
      {
        exportTimeoutMs: 10_000,
        flushTimeoutMs: 20_000,
        shutdownTimeoutMs: 20_000,
      },
    );
    try {
      // 17 MiB of four-byte characters after one to four ASCII ones: one of
      // the cuts falls inside a character, whatever the limit.
      const results = [1, 2, 3, 4].map(
        (pad) =>
          `${'x'.repeat(pad)}${'\u{1F600}'.repeat((17 * 1024 * 1024) / 4)}`,
      );
      for (const large of results) {
        const [client, served] = InMemoryTransport.createLinkedPair();
        await server(h.capture, large).connect(h.capture.transport(served));
        const agent = legacy();
        await agent.connect(client);
        await agent.callTool({ name: 'synthetic_tool', arguments: {} });
        await agent.close();
      }
      await h.sdk.client.flush();

      const calls = h
        .transportSpans()
        .filter((span) => span.name === 'mcp.tools/call:synthetic_tool');
      expect(calls).toHaveLength(results.length);
      for (const [index, call] of calls.entries()) {
        const attributes = attributesOf(call.attributes);
        const response = attributes[A.responsePayload];
        if (typeof response !== 'string')
          throw new Error('No response payload.');
        expect(attributes[A.responseTruncated]).toBe(true);
        expect(attributes[A.requestTruncated]).toBeUndefined();
        expect(attributes[A.requestPayload]).toBe(
          '{"name":"synthetic_tool","arguments":{}}',
        );
        expect(response.isWellFormed()).toBe(true);
        expect(
          JSON.stringify({
            content: [{ type: 'text', text: results[index] }],
          }).startsWith(response),
        ).toBe(true);
      }
      expect(
        h.sink.packets.every(
          (packet) => packet.bytes.byteLength <= OTLP.limits.bodyBytes,
        ),
      ).toBe(true);
      expect(h.failures).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe('MCP handler capture (createMcpHandler)', () => {
  // Fails if someone wraps the handler but leaves its calls uncounted,
  // counts a call twice, changes what the client gets, or sizes a message
  // other than as the SDK encodes it.
  it('records each received message of an SSE stream and of a JSON response, and leaves both responses as they were', async () => {
    const h = await harness();
    try {
      const factory = () => server(h.capture);
      const streamed = h.capture.handler(createMcpHandler(factory));
      const json = h.capture.handler(
        createMcpHandler(factory, {
          responseMode: 'json',
          legacy: 'stateless',
        }),
      );
      const agent = new Client({ name: 'synthetic-client', version: '1.0.0' });
      await agent.connect(
        new StreamableHTTPClientTransport(url, {
          fetch: (input, init) => streamed.fetch(new Request(input, init)),
        }),
      );
      const result = await agent.callTool({
        name: 'synthetic_tool',
        arguments: {},
      });
      expect(JSON.stringify(result)).toContain('SYNTHETIC_PRIVATE_RESULT');
      await expect(
        agent.callTool({ name: 'missing_tool', arguments: {} }),
      ).rejects.toThrow('missing_tool');
      await agent.close();

      const message = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'synthetic_tool',
          arguments: {},
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '2' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      };
      const response = await json.fetch(
        new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
            'mcp-name': 'synthetic_tool',
          },
          body: JSON.stringify(message),
        }),
      );
      const body = await response.text();
      expect(body).toContain('SYNTHETIC_PRIVATE_RESULT');

      await vi.waitFor(async () => {
        await h.sdk.client.flush();
        expect(h.transportSpans()).toHaveLength(5);
      });
      const transports = h.transportSpans();
      expect(transports.map((span) => span.name).sort()).toEqual([
        'mcp.initialize',
        'mcp.notifications/initialized',
        'mcp.tools/call:missing_tool',
        'mcp.tools/call:synthetic_tool',
        'mcp.tools/call:synthetic_tool',
      ]);
      const handlers = h
        .mcpSpans()
        .filter((span) => attributesOf(span.attributes)[A.layer] === 'handler');
      expect(handlers).toHaveLength(2);
      for (const child of handlers) {
        expect(
          attributesOf(child.attributes)[OTLP.spanAttributes.explicitStep],
        ).toBeUndefined();
        expect(
          transports.some((span) => child.parentSpanId?.equals(span.spanId)),
        ).toBe(true);
      }
      const missing = transports.find(
        (span) => span.name === 'mcp.tools/call:missing_tool',
      );
      expect(attributesOf(missing?.attributes)[A.errorCode]).toBe(-32602);
      const modern = transports.find(
        (span) =>
          attributesOf(span.attributes)[A.clientName] === 'modern-client',
      );
      expect(attributesOf(modern?.attributes)).toMatchObject({
        [A.requestBytes]: Buffer.byteLength(JSON.stringify(message)),
        [A.responseBytes]: Buffer.byteLength(JSON.stringify(JSON.parse(body))),
        [A.protocolVersion]: '2026-07-28',
      });
      // Stateless: no session to hash.
      expect(
        transports.every(
          (span) => attributesOf(span.attributes)[A.sessionHash] === undefined,
        ),
      ).toBe(true);
    } finally {
      await h.close();
    }
  });
});
