import { once } from 'node:events';
import { connect } from 'node:net';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { TRACE_HANDOFF_HEADER, verifyTraceHandoff } from 'agentrail-core';
import { CLI_HEADER_CONTRACT } from 'agentrail-contract';
import type { AgentrailNode } from '../../src/index.js';
import { attributesOf, type WireSpan } from './collector.js';
import { HASH_KEY } from './options.js';

/**
 * The scenario every "beside another tracer" test runs: a request carrying
 * the other tracer's headers reaches the application, which calls an
 * ordinary origin and an allowed one, each by `fetch` and by `http.request`,
 * inside a milestone, forwarding the CLI header and a tracestate of its own.
 */
export const CLI_VALUE = CLI_HEADER_CONTRACT.vectors.header.value;
export const APP_TRACESTATE = 'customer=synthetic';
export const OK = 'HTTP/1.1 200 OK';

export async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture port.');
  return `http://127.0.0.1:${address.port}`;
}
export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}
export interface Received {
  readonly headers: IncomingHttpHeaders;
  /** The SDK's signed handoff, checked as a receiving Agentrail SDK checks it. */
  readonly handoff: 'verified' | 'refused' | 'missing';
}
/** A service the application calls: what each call to it carried, by path. */
export async function downstream() {
  const seen = new Map<string, Received>();
  const server = createServer((request, response) => {
    void (async () => {
      const token = request.headers[TRACE_HANDOFF_HEADER];
      const traceparent = request.headers.traceparent;
      const verdict =
        typeof token === 'string'
          ? await verifyTraceHandoff(token, {
              traceparent: typeof traceparent === 'string' ? traceparent : null,
              method: request.method ?? '',
              target: request.url ?? '',
              now: Date.now(),
              hashKey: HASH_KEY,
            })
          : undefined;
      seen.set(request.url ?? '', {
        headers: request.headers,
        handoff:
          verdict === undefined
            ? 'missing'
            : verdict.kind === 'verified'
              ? 'verified'
              : 'refused',
      });
      response.end('ok');
    })();
  });
  const origin = await listen(server);
  const { port } = new URL(origin);
  return { origin, port: Number(port), seen, close: () => close(server) };
}
/** A request from the test itself, outside anything the SDK manages. */
export function send(
  url: string,
  headers: Record<string, string> = {},
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on('end', () => {
        resolve(response.statusCode);
      });
    })
      .on('error', reject)
      .end();
  });
}
/**
 * The request that reaches the application, written on a bare socket: the
 * other tracer's client instrumentation would give one sent with
 * `http.request` trace headers of its own in place of these.
 */
export async function arrive(
  url: string,
  headers: Record<string, string>,
): Promise<string> {
  const { hostname, port, pathname } = new URL(url);
  const socket = connect(Number(port), hostname);
  await once(socket, 'connect');
  const lines = Object.entries(headers).map(
    ([name, value]) => `${name}: ${value}`,
  );
  // Not ended: a server closes a connection its client half-closed.
  socket.write(
    [
      `GET ${pathname} HTTP/1.1`,
      `host: ${hostname}:${port}`,
      'connection: close',
      ...lines,
      '',
      '',
    ].join('\r\n'),
  );
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('latin1').split('\r\n')[0] ?? '';
}
/**
 * The application. `during` runs inside its handler, beside the calls, for
 * the other tracer's own work (a span of the customer's, say).
 */
export async function application(
  sdk: AgentrailNode,
  ordinary: string,
  allowed: string,
  during: () => Promise<void> = () => Promise.resolve(),
) {
  const server = createServer((request, response) => {
    void (async () => {
      sdk.identify({ kind: 'user', id: 'synthetic-person' });
      const forwarded = {
        'x-agentrail-cli': String(request.headers['x-agentrail-cli']),
        tracestate: APP_TRACESTATE,
      };
      await sdk.milestone(
        'order.placed',
        { surface: 'custom', kind: 'order.placed' },
        async () => {
          await during();
          for (const origin of [ordinary, allowed]) {
            const fetched = await fetch(`${origin}/fetch`, {
              headers: forwarded,
            });
            await fetched.text();
            await send(`${origin}/request`, forwarded);
          }
        },
      );
      response.end('done');
    })();
  });
  return { origin: await listen(server), close: () => close(server) };
}
/**
 * What the collector got, without what differs between two runs of the
 * same scenario: IDs and times. Each span names its parent by name.
 */
export function shape(spans: readonly WireSpan[]) {
  const byId = new Map(
    spans.map((span) => [Buffer.from(span.spanId).toString('hex'), span]),
  );
  return spans
    .map((span) => {
      const parent =
        span.parentSpanId === undefined || span.parentSpanId.length === 0
          ? null
          : (byId.get(Buffer.from(span.parentSpanId).toString('hex'))?.name ??
            'remote');
      return JSON.stringify({
        name: span.name,
        kind: span.kind,
        status: span.status?.code ?? 0,
        parent,
        links: span.links?.length ?? 0,
        attributes: Object.entries(attributesOf(span.attributes)).sort(),
      });
    })
    .sort();
}
/** The trace a call's one `traceparent` header names, if it has one. */
export function traceOf(call: Received | undefined): string | undefined {
  const header = call?.headers.traceparent;
  return typeof header === 'string' ? header.split('-')[1] : undefined;
}
/** The headers a call carried, by which origin and how it was made. */
export function calls(
  ordinary: Map<string, Received>,
  allowed: Map<string, Received>,
) {
  return {
    ordinaryFetch: ordinary.get('/fetch'),
    ordinaryRequest: ordinary.get('/request'),
    allowedFetch: allowed.get('/fetch'),
    allowedRequest: allowed.get('/request'),
  };
}
