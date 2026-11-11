import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import pinoLogger from 'pino';
import {
  hashKeyIdOf,
  signTraceHandoff,
  TRACE_HANDOFF_HEADER,
} from 'agentrail-core';
import { describe, expect, it } from 'vitest';
import { init } from '../src/index.js';
import { pino } from '../src/pino.js';
import { attributesOf, collector } from './support/collector.js';
import { options, HASH_KEY } from './support/options.js';

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture port.');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
}
// Using http avoids adding a client span for the test driver outside managed context.
async function get(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number | undefined; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(url, { headers }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          resolve({ status: response.statusCode, body });
        });
      });
      request.on('error', reject);
      request.end();
    },
  );
}
describe('standalone HTTP/fetch installation', () => {
  // Fails if ingress trusts a public parent, a signature skips target binding, or concurrent identities leak.
  it('continues only signed requests, isolates callers and propagates only to exact destinations', async () => {
    const sink = await collector();
    const failures: Error[] = [];
    const received: Record<string, string | string[] | undefined>[] = [];
    const downstream = createServer((request, response) => {
      received.push(request.headers);
      response.end('downstream');
    });
    const destination = await listen(downstream);
    const blockedHeaders: Record<string, string | string[] | undefined>[] = [];
    const blocked = createServer((request, response) => {
      blockedHeaders.push(request.headers);
      response.end('external');
    });
    const blockedOrigin = await listen(blocked);
    const configuration = {
      ...options(sink.endpoint),
      outboundOrigins: [destination],
      incomingLocation: (request: import('node:http').IncomingMessage) => {
        if (request.url === '/tampered')
          throw new TypeError('Location lookup failed');
        return {
          country: 'US',
          region: null,
          city: request.url === '/second' ? 'Boston' : 'Seattle',
          source: 'source' as const,
        };
      },
      ignoreIncomingRequest: (request: import('node:http').IncomingMessage) =>
        request.url === '/health',
      onError: (error: Error) => {
        failures.push(error);
      },
    };
    const sdk = await init(configuration);
    expect(await init(configuration)).toBe(sdk);
    const output: string[] = [];
    const logger = pinoLogger(
      { hooks: pino(sdk) },
      new Writable({
        write(chunk, _encoding, done) {
          output.push(String(chunk));
          done();
        },
      }),
    );
    const server = createServer((request, response) => {
      void (async () => {
        const id = request.url?.startsWith('/second')
          ? 'second-agent'
          : 'first-agent';
        sdk.identify({ kind: 'agent_instance', id });
        await new Promise((resolve) => {
          setTimeout(resolve, id === 'first-agent' ? 8 : 1);
        });
        logger.error(
          { err: new TypeError('SYNTHETIC_PRIVATE_MESSAGE') },
          'SYNTHETIC_PRIVATE_MESSAGE',
        );
        if (request.url?.startsWith('/signed')) {
          await fetch(`${destination}/work`, {
            headers: {
              baggage: 'private=hidden',
              tracestate: 'private=hidden',
            },
          });
          await get(`${destination}/native`, {
            host: 'forged.invalid',
            baggage: 'private=hidden',
          });
          await fetch(`${blockedOrigin}/external`, {
            headers: {
              traceparent: parent,
              [TRACE_HANDOFF_HEADER]: token,
              baggage: 'private=hidden',
            },
          });
        }
        if (request.url === '/conflict')
          sdk.identify({ kind: 'agent_instance', id: 'conflicting-agent' });
        response.writeHead(503);
        response.end('application failure preserved');
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : undefined);
      });
    });
    const origin = await listen(server);
    const parent = '00-11111111111111111111111111111111-2222222222222222-01';
    const token = await signTraceHandoff(
      {
        traceparent: parent,
        hashKeyId: await hashKeyIdOf(HASH_KEY),
        issuedAt: Date.now(),
        method: 'GET',
        target: '/signed?private=hidden',
      },
      HASH_KEY,
    );
    try {
      const responses = await Promise.all([
        get(`${origin}/signed?private=hidden`, {
          traceparent: parent,
          [TRACE_HANDOFF_HEADER]: token,
        }),
        get(`${origin}/second`, {
          traceparent: parent,
          baggage: 'user.id=forged',
        }),
        get(`${origin}/tampered`, {
          traceparent: parent,
          [TRACE_HANDOFF_HEADER]: token,
        }),
        get(`${origin}/conflict`),
      ]);
      expect(
        responses.every(
          (response) =>
            response.status === 503 &&
            response.body === 'application failure preserved',
        ),
      ).toBe(true);
      await sdk.flush();
      const entries = sink.spans().filter((span) => span.kind === 2);
      const signed = entries.find(
        (span) =>
          attributesOf(span.attributes)['url.full'] === `${origin}/signed`,
      );
      expect(
        signed,
        JSON.stringify(
          entries.slice(0, 8).map((span) => attributesOf(span.attributes)),
        ),
      ).toBeDefined();
      if (signed?.parentSpanId === undefined)
        throw new Error('Expected a signed backend entry.');
      expect(Buffer.from(signed.traceId).toString('hex')).toBe('1'.repeat(32));
      expect(Buffer.from(signed.parentSpanId).toString('hex')).toBe(
        '2'.repeat(16),
      );
      expect(
        attributesOf(signed.attributes)['agentrail.ingress.verified'],
      ).toBe(true);
      const unsigned = entries.filter((span) =>
        ['/second', '/tampered'].some(
          (path) => attributesOf(span.attributes)['url.full'] === origin + path,
        ),
      );
      expect(unsigned).toHaveLength(2);
      expect(
        unsigned.every(
          (span) =>
            Buffer.from(span.traceId).toString('hex') !== '1'.repeat(32) &&
            span.links?.length === 1,
        ),
      ).toBe(true);
      const first = entries.find(
        (span) =>
          attributesOf(span.attributes)['url.full'] === `${origin}/conflict`,
      );
      const second = entries.find(
        (span) =>
          attributesOf(span.attributes)['url.full'] === `${origin}/second`,
      );
      expect(
        attributesOf(first?.attributes)['agentrail.client.location.city'],
      ).toBe('Seattle');
      expect(
        attributesOf(second?.attributes)['agentrail.client.location.city'],
      ).toBe('Boston');
      expect(
        attributesOf(first?.attributes)['agentrail.principal.id_hash'],
      ).not.toBe(
        attributesOf(second?.attributes)['agentrail.principal.id_hash'],
      );
      expect(
        sink
          .spans()
          .filter(
            (span) =>
              attributesOf(span.attributes)['agentrail.step.kind'] ===
              'auth.identity',
          ),
      ).toHaveLength(1);
      const downstreamEntries = entries.filter(
        (span) =>
          attributesOf(span.attributes)['agentrail.ingress.verified'] === true,
      );
      expect(downstreamEntries).toHaveLength(3);
      expect(
        downstreamEntries.every(
          (span) =>
            Buffer.from(span.traceId).toString('hex') === '1'.repeat(32),
        ),
      ).toBe(true);
      expect(received[0]?.traceparent).toBeDefined();
      expect(received[0]?.[TRACE_HANDOFF_HEADER]).toBeDefined();
      expect(received[0]?.baggage).toBeUndefined();
      expect(received[0]?.tracestate).toBeUndefined();
      expect(received[1]?.host).toBe('forged.invalid');
      expect(received[1]?.[TRACE_HANDOFF_HEADER]).toBeDefined();
      expect(blockedHeaders[0]?.traceparent).toBeUndefined();
      expect(blockedHeaders[0]?.[TRACE_HANDOFF_HEADER]).toBeUndefined();
      expect(blockedHeaders[0]?.baggage).toBeUndefined();
      expect(failures).toHaveLength(2);
      expect(failures).toContainEqual(
        expect.objectContaining({ code: 'location_failed' }),
      );
      expect(
        JSON.stringify(sink.packets.map((packet) => packet.bytes.toString())),
      ).not.toContain('SYNTHETIC_PRIVATE_MESSAGE');
      expect(output.join('')).toContain('SYNTHETIC_PRIVATE_MESSAGE');
      expect(sink.logs()).toHaveLength(4);
    } finally {
      await sdk.shutdown();
      await close(server);
      await close(downstream);
      await close(blocked);
      await sink.close();
    }
  });
});
