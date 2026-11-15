import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { connect } from 'node:net';
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
} from '@modelcontextprotocol/server';
import { OTLP, type McpRecordedRequest } from 'agentrail-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { init, type AgentrailNode } from '../src/index.js';
import { mcp } from '../src/mcp.js';
import { attributesOf, collector, type WireSpan } from './support/collector.js';
import { options } from './support/options.js';

const A = OTLP.mcpAttributes;
const [CLAUDE_CODE, CODEX] = OTLP.mcpRequestFacts.requests;
if (CLAUDE_CODE === undefined || CODEX === undefined)
  throw new Error('The contract holds no recorded MCP requests.');
/** What an SDK's step span says of the request that carried its message (`mcpSpans.requestFacts`). */
const FACTS = [
  'http.request.method',
  'url.full',
  'user_agent.original',
  A.headerNames,
  A.accept,
  A.acceptEncoding,
  A.jsonrpcId,
  'gen_ai.tool.name',
];
/**
 * What no attribute may carry: header values other than the user agent's,
 * Accept's and Accept-Encoding's, and a query outside the marker lane.
 */
const QUERY = 'SYNTHETIC_QUERY_VALUE';
const PRIVATE_VALUES = ['Bearer stand-in', '203.0.113.7', QUERY];
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** `tool`: a transport left unwrapped, so the wrapped tool callback is the step. */
type Wrapper = 'transport' | 'handler' | 'tool';
let sink: Awaited<ReturnType<typeof collector>>;
let sdk: AgentrailNode;
/** Servers the SDK's HTTP instrumentation is told to leave out, by port. */
const unseen = new Set<number>();
const servers: ReturnType<typeof createServer>[] = [];

beforeAll(async () => {
  sink = await collector();
  sdk = await init({
    ...options(sink.endpoint),
    ignoreIncomingRequest: (request) =>
      unseen.has(request.socket.localPort ?? 0),
  });
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await sdk.shutdown();
  await sink.close();
});

function projects(capture: ReturnType<typeof mcp>) {
  const server = new McpServer({ name: 'synthetic-server', version: '1' });
  server.registerTool(
    'list_projects',
    {},
    capture.tool('list_projects', () => ({
      content: [{ type: 'text', text: 'SYNTHETIC_PROJECTS' }],
    })),
  );
  return server;
}
/** The MCP endpoint, through one wrapper: a stateless transport per request, or createMcpHandler. */
function endpoint(wrapper: Wrapper): (request: Request) => Promise<Response> {
  const capture = mcp({ client: sdk });
  if (wrapper === 'handler') {
    const handler = capture.handler(
      createMcpHandler(() => projects(capture), { responseMode: 'json' }),
    );
    return (request) => handler.fetch(request);
  }
  return async (request) => {
    const inner = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    const transport = wrapper === 'tool' ? inner : capture.transport(inner);
    await projects(capture).connect(transport);
    return transport.handleRequest(request);
  };
}
/**
 * A Fetch Request from Node's, as an application behind a TLS-terminating
 * proxy makes one: on the scheme it is served on, for the host asked for,
 * every header as it came.
 */
async function fetchRequestOf(incoming: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  const headers = new Headers();
  const raw = incoming.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2)
    headers.append(raw[index] ?? '', raw[index + 1] ?? '');
  return new Request(
    new URL(incoming.url ?? '/', `https://${incoming.headers.host ?? ''}`),
    {
      method: incoming.method ?? 'GET',
      headers,
      body: new Uint8Array(Buffer.concat(chunks)),
    },
  );
}
/** A real HTTP server for one wrapper, seen by the SDK's HTTP instrumentation or left out of it. */
async function serve(wrapper: Wrapper, seen: boolean): Promise<number> {
  const handle = endpoint(wrapper);
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const response = await handle(await fetchRequestOf(incoming));
      const body = Buffer.from(await response.arrayBuffer());
      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        'content-length': body.length,
        // The replay reads the answer to its end.
        connection: 'close',
      });
      outgoing.end(body);
    })().catch((error: unknown) => {
      outgoing.destroy(error instanceof Error ? error : undefined);
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No test server port.');
  if (!seen) unseen.add(address.port);
  return address.port;
}
/**
 * Writes a recorded request on a socket as its client wrote it: its
 * headers in their order and case, nothing added, only Content-Length set
 * to its body's true length. Returns the whole answer.
 */
async function replay(port: number, recorded: McpRecordedRequest) {
  const body = JSON.stringify(recorded.body);
  const head = recorded.headers
    .map(
      ([name, value]) =>
        `${name}: ${name.toLowerCase() === 'content-length' ? Buffer.byteLength(body) : value}\r\n`,
    )
    .join('');
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const { pathname, search } = new URL(recorded.url);
  socket.write(
    `${recorded.method} ${pathname}${search} HTTP/1.1\r\n${head}\r\n${body}`,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}
/** Replays a request, and returns the step span it gave. */
async function stepOf(port: number, recorded: McpRecordedRequest) {
  const before = sink.spans().length;
  const answer = await replay(port, recorded);
  expect(answer).toMatch(/^HTTP\/1\.1 200 /u);
  expect(answer).toContain('SYNTHETIC_PROJECTS');
  await sdk.flush();
  const steps = sink
    .spans()
    .slice(before)
    .filter(
      (span) =>
        attributesOf(span.attributes)[OTLP.spanAttributes.explicitStep] ===
        true,
    );
  expect(steps.map((span) => span.name)).toEqual([
    'mcp.tools/call:list_projects',
  ]);
  const [step] = steps;
  if (step === undefined) throw new Error('The replay gave no step span.');
  return step;
}
function factsOf(span: WireSpan) {
  const attributes = attributesOf(span.attributes);
  return Object.fromEntries(
    FACTS.flatMap((key) =>
      attributes[key] === undefined ? [] : [[key, attributes[key]]],
    ),
  );
}
const namesOf = (span: WireSpan) =>
  String(attributesOf(span.attributes)[A.headerNames]).split(',');

describe('MCP request facts, replayed through a real HTTP server', () => {
  // Fails if someone reads the names from the Fetch Headers where Node's
  // rawHeaders kept their order and case, drops or renames a fact, or sends
  // an Accept-Encoding the request never had.
  it.each<[Wrapper]>([['transport'], ['handler'], ['tool']])(
    'sends, through the %s wrapper, the attributes the contract gives each recorded request, its header names in arrival order and case',
    async (wrapper) => {
      const port = await serve(wrapper, true);
      for (const recorded of [CLAUDE_CODE, CODEX]) {
        const step = await stepOf(port, recorded);
        expect(factsOf(step)).toEqual(recorded.attributes);
        // The handler wrapper sees the HTTP answer before the call ends;
        // the transport wrapper and a tool callback only the JSON-RPC one.
        expect(attributesOf(step.attributes)['http.response.status_code']).toBe(
          wrapper === 'handler' ? 200 : undefined,
        );
      }
    },
  );

  // Where the SDK's HTTP instrumentation did not see the request (another
  // OpenTelemetry setup, or a request it leaves out), only the Fetch
  // Headers know the names: lower-cased and sorted, so they are compared as
  // a set. Fails if someone sends no names there, or invents an order.
  it.each<[Wrapper]>([['transport'], ['handler'], ['tool']])(
    'sends, through the %s wrapper, the same facts with the names lower-cased where Node did not keep them',
    async (wrapper) => {
      const port = await serve(wrapper, false);
      for (const recorded of [CLAUDE_CODE, CODEX]) {
        const step = await stepOf(port, recorded);
        const { [A.headerNames]: names, ...rest } = recorded.attributes;
        const { [A.headerNames]: sent, ...facts } = factsOf(step);
        expect(facts).toEqual(rest);
        expect(String(sent).split(',')).toEqual(
          String(names).toLowerCase().split(',').sort(),
        );
      }
    },
  );

  // Fails if a header's value reaches the names (rawHeaders joined whole, or
  // `name: value` pairs), any value but the user agent's, Accept's and
  // Accept-Encoding's leaves the process, the URL keeps its query, or Host is
  // left out of the names.
  it('sends names only, never a value, and Host among them, from every wrapper and runtime', async () => {
    for (const wrapper of ['transport', 'handler', 'tool'] as const)
      for (const seen of [true, false]) {
        const port = await serve(wrapper, seen);
        for (const recorded of [CLAUDE_CODE, CODEX]) {
          const before = sink.packets.length;
          const step = await stepOf(port, {
            ...recorded,
            url: `${recorded.url}?token=${QUERY}`,
          });
          expect(attributesOf(step.attributes)['url.full']).toBe(recorded.url);
          const names = namesOf(step);
          expect(names.every((name) => HTTP_TOKEN.test(name))).toBe(true);
          expect(names.map((name) => name.toLowerCase()).sort()).toEqual(
            recorded.headers.map(([name]) => name.toLowerCase()).sort(),
          );
          expect(names.map((name) => name.toLowerCase())).toContain('host');
          const exported = Buffer.concat(
            sink.packets.slice(before).map((packet) => packet.bytes),
          ).toString();
          for (const value of PRIVATE_VALUES)
            expect(exported).not.toContain(value);
        }
      }
  });

  // Fails if someone sends the names unbounded, or cuts them inside a name.
  it('sends a long list of names cut between names, the first ones as they came', async () => {
    const port = await serve('handler', true);
    const padding = Array.from(
      { length: 300 },
      (_, index) =>
        [`x-synthetic-pad-${String(index).padStart(3, '0')}`, 'v'] as const,
    );
    const names = namesOf(
      await stepOf(port, {
        ...CLAUDE_CODE,
        headers: [...CLAUDE_CODE.headers, ...padding],
      }),
    );
    const sent = [...CLAUDE_CODE.headers, ...padding].map(([name]) => name);
    expect(names.join(',').length).toBeLessThanOrEqual(4096);
    expect(names.join(',').length).toBeGreaterThan(4096 - 21);
    expect(names).toEqual(sent.slice(0, names.length));
  });
});
