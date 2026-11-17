import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';

import { CLI_HEADER_CONTRACT, OTLP } from 'agentrail-contract';
import { expect, it } from 'vitest';

import { init } from '../src/index.js';
import { attributesOf, collector } from './support/collector.js';
import { options } from './support/options.js';

const { header, unread, keyedSession } = CLI_HEADER_CONTRACT.vectors;
const names = OTLP.cliAttributes;

/** A request with these headers, one line for each value, as a CLI's HTTP client writes them. */
function send(
  url: string,
  headers: Record<string, string | string[]> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on('end', resolve);
    })
      .on('error', reject)
      .end();
  });
}

// Fails if someone stops reading the header, sends the session as the CLI
// gave it, or puts the facts under names the collector does not read: a
// CLI's runs would join no journey, or its session would leave unhashed.
// Also fails if a header that does not read, or one sent twice (which Node
// joins into one value), sets anything: the collector would take a session
// no CLI SDK named.
it("records what a CLI's header says on the request's span, its session hashed", async () => {
  const sink = await collector();
  const failures: Error[] = [];
  const sdk = await init({
    ...options(sink.endpoint),
    hashKey: keyedSession.hashKey,
    onError: (error) => {
      failures.push(error);
    },
  });
  const server = createServer((_request, response) => {
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('No fixture address.');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    await send(`${origin}/cli`, { 'x-agentrail-cli': header.value });
    await send(`${origin}/plain`);
    for (const value of unread.filter((text) => text !== ''))
      await send(`${origin}/unread`, { 'x-agentrail-cli': value });
    await send(`${origin}/twice`, {
      'x-agentrail-cli': [header.value, header.value],
    });
    await sdk.flush();
    const spans = sink.spans().map((span) => attributesOf(span.attributes));
    const cliOf = (attributes: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(attributes).filter(([key]) =>
          key.startsWith('agentrail.cli.'),
        ),
      );
    const byPath = (path: string) =>
      spans.filter((attributes) => attributes['url.full'] === origin + path);
    const { reads } = header;
    expect(byPath('/cli').map(cliOf)).toEqual([
      {
        [names.name]: reads.cli,
        [names.version]: reads.cliVersion,
        [names.command]: reads.command,
        [names.run]: reads.run,
        [names.sequence]: reads.sequence,
        [names.mode]: reads.mode,
        [names.sessionHash]: keyedSession.hash,
        [names.sessionFrom]: reads.sessionFrom,
        [names.agent]: reads.agent,
        [names.agentVersion]: reads.agentVersion,
        [names.evidence]: reads.evidence?.join(','),
        [names.sdkVersion]: reads.sdkVersion,
      },
    ]);
    expect(reads.session).toBe(keyedSession.session);
    expect(JSON.stringify(sink.spans())).not.toContain(reads.session);
    for (const path of ['/plain', '/unread', '/twice'])
      for (const attributes of byPath(path))
        expect(cliOf(attributes)).toEqual({});
    expect(byPath('/unread')).toHaveLength(unread.length - 1);
    expect(failures).toEqual([]);
  } finally {
    await sdk.shutdown();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    await sink.close();
  }
});
