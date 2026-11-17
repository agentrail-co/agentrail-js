import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';

import { SpanKind, trace } from '@opentelemetry/api';
import { CLI_HEADER_CONTRACT } from 'agentrail-contract';
import { expect, it } from 'vitest';

import { init } from '../src/index.js';
import { attributesOf, collector } from './support/collector.js';
import { options } from './support/options.js';

const { header, keyedSession } = CLI_HEADER_CONTRACT.vectors;

/** A request with these headers, one line for each value, as a CLI's HTTP client writes them. */
function send(
  url: string,
  headers: Record<string, string | string[]> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', resolve);
    })
      .on('error', reject)
      .end();
  });
}

// Fails if someone copies a CLI's facts onto every server span of the
// request, or lets the server send the header on: a library's own server
// span inside the request would be a second CLI step, and the next service
// would learn the CLI's run and session though the CLI never listed it.
it("keeps a CLI's header to the request's own span, and off the calls its server makes", async () => {
  const sink = await collector();
  const sdk = await init({
    ...options(sink.endpoint),
    hashKey: keyedSession.hashKey,
    outboundOrigins: [],
  });
  const received: (string | undefined)[] = [];
  const downstream = createServer((request, response) => {
    const value = request.headers['x-agentrail-cli'];
    received.push(typeof value === 'string' ? value : undefined);
    response.end('ok');
  });
  downstream.listen(0, '127.0.0.1');
  await once(downstream, 'listening');
  const downAddress = downstream.address();
  if (downAddress === null || typeof downAddress === 'string')
    throw new Error('No downstream address.');
  const downOrigin = `http://127.0.0.1:${downAddress.port}`;
  const server = createServer((request, response) => {
    void (async () => {
      const value = request.headers['x-agentrail-cli'];
      const forwarded =
        typeof value === 'string' ? { 'x-agentrail-cli': value } : {};
      // A library's own server span inside the request, as an RPC layer opens one.
      await trace
        .getTracer('a-library')
        .startActiveSpan('inner', { kind: SpanKind.SERVER }, async (inner) => {
          await fetch(`${downOrigin}/fetched`, { headers: forwarded });
          await send(`${downOrigin}/requested`, forwarded);
          inner.end();
        });
      response.end('{}');
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture address.');
  try {
    await send(`http://127.0.0.1:${address.port}/cli`, {
      'x-agentrail-cli': header.value,
    });
    await sdk.flush();
    const withCli = sink
      .spans()
      .filter((span) =>
        Object.keys(attributesOf(span.attributes)).some((key) =>
          key.startsWith('agentrail.cli.'),
        ),
      );
    expect(withCli.map((span) => span.name)).toEqual(['HTTP POST']);
    expect(received).toEqual([undefined, undefined]);
  } finally {
    await sdk.shutdown();
    for (const each of [server, downstream]) {
      each.closeAllConnections();
      each.close();
      await once(each, 'close');
    }
    await sink.close();
  }
});
