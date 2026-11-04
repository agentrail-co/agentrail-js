import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  TRACE_HANDOFF_HEADER,
  newMarker,
  verifyTraceHandoff,
} from 'agentrail-core';
import { describe, expect, it, vi } from 'vitest';

import { createEdge, type EdgeAdapter } from '../src/index.js';

const HASH_KEY = 'synthetic-workspace-key-for-handoff-tests';

describe('edge to origin handoff over HTTP', () => {
  // Fails if a caller header survives, a rewrite happens after signing, or the token reaches the visitor.
  it.each([false, true])(
    'signs the final rewritten request and keeps the handoff out of the response (sign failure: %s)',
    async (failSigning) => {
      const server = createServer((request, response) => {
        void (async () => {
          const token = request.headers[TRACE_HANDOFF_HEADER];
          const traceparent = request.headers.traceparent;
          if (request.method === undefined || request.url === undefined)
            throw new Error('No test request method or target.');
          const verification = await verifyTraceHandoff(
            typeof token === 'string' ? token : null,
            {
              hashKey: HASH_KEY,
              traceparent: typeof traceparent === 'string' ? traceparent : null,
              method: request.method,
              target: request.url,
              now: Date.now(),
            },
          );
          response.setHeader('content-type', 'application/json');
          if (typeof token === 'string')
            response.setHeader(TRACE_HANDOFF_HEADER, token);
          response.end(
            JSON.stringify({
              verification,
              target: request.url,
              baggage: request.headers.baggage ?? null,
            }),
          );
        })().catch((error: unknown) =>
          response.destroy(
            error instanceof Error
              ? error
              : new Error('The test origin failed.', { cause: error }),
          ),
        );
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('No test listener port.');
      const work: Promise<unknown>[] = [];
      const failures: Error[] = [];
      const signing = failSigning
        ? vi
            .spyOn(crypto.subtle, 'sign')
            .mockRejectedValueOnce(new Error('Synthetic signing failure.'))
        : undefined;
      const edge = createEdge({
        hashKey: HASH_KEY,
        hosts: { 'public.test': 'query' },
        collector: {
          endpoint: 'https://collector.test',
          secret: 'ajs_synthetic_test_source',
        },
        fetch: () => Promise.resolve(Response.json({ accepted: 1 })),
        onError: (error) => {
          failures.push(error);
        },
      });
      const adapter: EdgeAdapter = {
        instance: null,
        clientAddress: () => null,
        waitUntil: (pending) => {
          work.push(pending);
        },
        prepareOriginRequest: (request) => {
          const target = new URL(request.url);
          target.host = `127.0.0.1:${address.port}`;
          target.protocol = 'http:';
          target.pathname = `/rewritten${target.pathname}`;
          return new Request(target, request);
        },
        origin: (request) => {
          const target = new URL(request.url);
          target.host = `127.0.0.1:${address.port}`;
          target.protocol = 'http:';
          return fetch(new Request(target, request));
        },
      };
      try {
        const marker = newMarker();
        const response = await edge.handle(
          new Request(`https://public.test/h/${marker}/api?x=1+2&h=${marker}`, {
            headers: {
              [TRACE_HANDOFF_HEADER]: 'caller-controlled',
              traceparent: `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01`,
              baggage: 'private=omit',
            },
          }),
          adapter,
        );
        const received: unknown = await response.json();
        expect(received).toMatchObject({
          verification: failSigning
            ? { kind: 'refused', reason: 'missing' }
            : { kind: 'verified' },
          target: '/rewritten/api?x=1+2',
          baggage: null,
        });
        expect(response.headers.get(TRACE_HANDOFF_HEADER)).toBeNull();
        expect(JSON.stringify(received)).not.toContain('f'.repeat(32));
        await Promise.all(work);
        expect(failures.map((error) => error.name)).toEqual(
          failSigning ? ['TraceHandoffSigningError'] : [],
        );
      } finally {
        signing?.mockRestore();
        server.closeAllConnections();
        server.close();
        await once(server, 'close');
      }
    },
  );
});
