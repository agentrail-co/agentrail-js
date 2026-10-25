import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CollectorUnavailableError,
  createCollector,
  type AgentrailEvent,
} from '../src/index.js';

import { COMPONENT, event } from './support/event.js';

/** A call as the collector's server received it. */
interface Received {
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly events: AgentrailEvent[];
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

/** A collector on a local port that answers each call with the next status. */
async function collectorServer(statuses: number[]) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      received.push({
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        events: (JSON.parse(body) as { events: AgentrailEvent[] }).events,
      });
      response
        .writeHead(statuses.shift() ?? 200, {
          'content-type': 'application/json',
        })
        .end('{"accepted":1}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${String(port)}`, received };
}

/** A collector client on Node's own fetch, with its waits and its losses. */
function client(endpoint: string) {
  const waits: number[] = [];
  const errors: Error[] = [];
  const collector = createCollector({
    endpoint,
    secret: 'ajs_secret',
    component: COMPONENT,
    onError: (error) => errors.push(error),
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { collector, waits, errors };
}

describe('the collector client over HTTP', () => {
  // Fails if someone stops trying a call again when the collector answers
  // 5xx, or sends it anywhere but /ingest/events, without the secret, or as
  // anything but JSON.
  it('delivers events to a collector that failed the first call, with the source secret', async () => {
    const { endpoint, received } = await collectorServer([503]);
    const { collector, waits, errors } = client(endpoint);
    collector.enqueue(event('e1'));
    await collector.flush();

    expect(errors).toEqual([]);
    expect(waits).toEqual([250]);
    expect(received).toHaveLength(2);
    for (const call of received)
      expect(call).toEqual({
        path: '/ingest/events',
        authorization: 'Bearer ajs_secret',
        contentType: 'application/json',
        events: [event('e1')],
      });
  });

  // Fails if someone tries again only what the collector answered: when
  // nothing answers, Node's fetch rejects, and that call is worth another.
  it('tries a collector that is not listening again, then gives the events up to onError', async () => {
    const { endpoint } = await collectorServer([]);
    const server = servers.pop();
    await new Promise((resolve) => server?.close(resolve));
    const { collector, waits, errors } = client(endpoint);
    collector.enqueue(event('e1'));
    await collector.flush();

    expect(waits).toEqual([250, 1_000]);
    expect(errors).toEqual([expect.any(CollectorUnavailableError)]);
    expect(errors[0]?.cause).toBeInstanceOf(TypeError);
  });
});
