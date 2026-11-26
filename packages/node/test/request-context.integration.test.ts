import { once } from 'node:events';
import http, { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { keyedHash } from 'agentrail-core';
import { expect, it } from 'vitest';
import { init, type CaptureError } from '../src/index.js';
import { downstream, listen } from './support/beside.js';
import { attributesOf, collector } from './support/collector.js';
import { HASH_KEY, options } from './support/options.js';

/** A request whose body arrives after its headers, on a connection the agent keeps. */
async function post(agent: http.Agent, url: string) {
  const request = http.request(url, { method: 'POST', agent });
  request.flushHeaders();
  await sleep(20);
  request.end('body');
  const [response] = (await once(request, 'response')) as [
    http.IncomingMessage,
  ];
  response.resume();
  await once(response, 'end');
  return request.reusedSocket;
}

// Fails if a request's state stops reaching its body's 'data' and 'end'
// listeners (Node 24 runs them in the connection's context, and Express's
// body parser calls the route from there), or if the next request on the
// same connection inherits it (Node 22 keeps an entered context on the
// connection): that request's identity and calls would be the first's.
it("keeps a request's state to that request, its body's listeners included", async () => {
  const sink = await collector();
  const failures: CaptureError[] = [];
  const called = await downstream();
  const sdk = await init({
    ...options(sink.endpoint),
    ignoreIncomingRequest: (request) =>
      request.url === '/ignored' || request.socket.localPort === called.port,
    onError: (error) => {
      failures.push(error);
    },
  });
  const app = createServer((request, response) => {
    request.on('data', () => undefined);
    request.on('end', () => {
      void (async () => {
        sdk.identify({ kind: 'user', id: `person${request.url ?? ''}` });
        await (await fetch(`${called.origin}${request.url ?? ''}`)).text();
        response.end('ok');
      })();
    });
  });
  const origin = await listen(app);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    expect(await post(agent, `${origin}/managed`)).toBe(false);
    expect(await post(agent, `${origin}/ignored`)).toBe(true);
    await sdk.flush();
    const spans = sink.spans();
    const entry = spans.find((span) => span.kind === 2);
    expect(attributesOf(entry?.attributes)['url.full']).toBe(
      `${origin}/managed`,
    );
    expect(attributesOf(entry?.attributes)['agentrail.principal.id_hash']).toBe(
      await keyedHash(HASH_KEY, 'person/managed'),
    );
    const outbound = spans.filter((span) => span.kind === 3);
    expect(
      outbound.map((span) => attributesOf(span.attributes)['url.full']),
    ).toEqual([`${called.origin}/managed`]);
    expect(
      outbound[0]?.parentSpanId?.equals(entry?.spanId ?? Buffer.alloc(0)),
    ).toBe(true);
    expect(spans).toHaveLength(2);
    expect(failures.map((error) => error.code)).toEqual([
      'identity_outside_request',
    ]);
  } finally {
    agent.destroy();
    await sdk.shutdown();
    app.closeAllConnections();
    app.close();
    await called.close();
    await sink.close();
  }
});
