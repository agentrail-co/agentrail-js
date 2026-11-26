import { once } from 'node:events';
import http, { createServer, type ClientRequest } from 'node:http';
import https from 'node:https';
import { connect } from 'node:net';
import { TRACE_HANDOFF_HEADER } from 'agentrail-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { init, type AgentrailNode } from '../src/index.js';
import { CLI_VALUE, OK, arrive, downstream, listen } from './support/beside.js';
import { collector } from './support/collector.js';
import { options } from './support/options.js';

// Bound before init, as an ESM loader (import-in-the-middle, which
// OpenTelemetry's and Datadog's ESM setups register) leaves a named import
// of node:http: the SDK's wrappers never see these.
const unwrapped = { request: http.request, get: http.get };

/** Waits for a call's response to be read to its end. */
async function answered(request: ClientRequest): Promise<void> {
  const [response] = (await once(request, 'response')) as [
    http.IncomingMessage,
  ];
  response.resume();
  await once(response, 'end');
}
let sink: Awaited<ReturnType<typeof collector>>;
let allowed: Awaited<ReturnType<typeof downstream>>;
let elsewhere: Awaited<ReturnType<typeof downstream>>;
let sdk: AgentrailNode;
beforeAll(async () => {
  sink = await collector();
  allowed = await downstream();
  elsewhere = await downstream();
  sdk = await init({
    ...options(sink.endpoint),
    outboundOrigins: [
      allowed.origin,
      `https://127.0.0.1:${String(allowed.port)}`,
      'https://127.0.0.1',
    ],
    ignoreIncomingRequest: (request) =>
      [allowed.port, elsewhere.port].includes(request.socket.localPort ?? 0),
  });
});
afterAll(async () => {
  await sdk.shutdown();
  await allowed.close();
  await elsewhere.close();
  await sink.close();
});
/**
 * As agent-base (under https-proxy-agent and the like) is: its default port
 * and protocol are getters that read the call stack, and say https only
 * inside Node's own https code. It tunnels to the allowed server.
 */
function proxyAgent(port: number): http.Agent {
  const insideHttps = () => new Error().stack?.includes('node:https') === true;
  class ProxyAgent extends http.Agent {}
  Object.defineProperties(ProxyAgent.prototype, {
    defaultPort: {
      get: () => (insideHttps() ? 443 : 80),
      set: () => undefined,
    },
    protocol: {
      get: () => (insideHttps() ? 'https:' : 'http:'),
      set: () => undefined,
    },
  });
  return Object.assign(new ProxyAgent(), {
    createConnection: () => connect(port, '127.0.0.1'),
  });
}
/** The application: `handle` runs inside the one request it is sent. */
async function application(
  handle: (request: http.IncomingMessage) => Promise<void>,
  headers: Record<string, string> = {},
) {
  const app = createServer((request, response) => {
    void handle(request).then(() => response.end('done'));
  });
  const origin = await listen(app);
  try {
    expect(await arrive(`${origin}/`, headers)).toBe(OK);
  } finally {
    app.closeAllConnections();
    app.close();
  }
}

// Fails if someone admits a call by its Host header, which the caller sets
// to anything, or by its host alone, ignoring the port: a signed handoff
// would reach a service the application never allowed. Also fails if one of
// the ways Node takes a call's destination (a URL string, a URL, options,
// both, a callback, `get`, `https`, a port Node falls back to, a proxy
// agent whose default port is a getter) goes unsigned.
it("signs a call only for an allowed origin, by the call's actual destination", async () => {
  const target = allowed.origin;
  const { port } = allowed;
  // Plain HTTP on the wire: what Node thinks it is (https) decides.
  const tunnel = () => connect(port, '127.0.0.1');
  const agent = Object.assign(new http.Agent(), { defaultPort: port });
  await application(async () => {
    const calls: ClientRequest[] = [
      http.request(`${target}/string`),
      http.request(new URL(`${target}/url`)),
      http.request({ hostname: '127.0.0.1', port, path: '/options' }),
      http.request(`${target}/string-options`, { method: 'POST' }),
      http.request(
        new URL(`${target}/url-options-callback`),
        {},
        () => undefined,
      ),
      http.request(
        { host: '127.0.0.1', port, path: '/options-callback' },
        () => undefined,
      ),
      https.request({
        hostname: '127.0.0.1',
        port,
        path: '/https',
        createConnection: tunnel,
      }),
      // No port: the one Node falls back to, as it does.
      http.request({
        hostname: '127.0.0.1',
        defaultPort: port,
        path: '/default-port',
      }),
      http.request({ hostname: '127.0.0.1', agent, path: '/agent-port' }),
      https.request('https://127.0.0.1/proxy-agent', {
        agent: proxyAgent(port),
      }),
      // Another port on the allowed host.
      http.request(`${elsewhere.origin}/other-port`),
      // Another host, whose Host header names the allowed origin.
      http.request(`http://localhost:${String(port)}/host-header`, {
        headers: { host: `127.0.0.1:${String(port)}` },
      }),
    ];
    for (const call of calls) {
      call.end();
      await answered(call);
    }
    // A get is sent as it is made: each is waited on from the start, or
    // its response could come before the wait does.
    await Promise.all(
      [
        http.get(`${target}/get`),
        http.get({ hostname: '127.0.0.1', port, path: '/get-options' }),
        https.get(`https://127.0.0.1:${String(port)}/https-get`, {
          createConnection: tunnel,
        }),
      ].map((call) => answered(call)),
    );
  });
  const handoffs = Object.fromEntries(
    [...allowed.seen, ...elsewhere.seen].map(([path, call]) => [
      path,
      call.handoff,
    ]),
  );
  expect(handoffs).toEqual({
    '/string': 'verified',
    '/url': 'verified',
    '/options': 'verified',
    '/string-options': 'verified',
    '/url-options-callback': 'verified',
    '/options-callback': 'verified',
    '/https': 'verified',
    '/default-port': 'verified',
    '/agent-port': 'verified',
    '/proxy-agent': 'verified',
    '/other-port': 'missing',
    '/host-header': 'missing',
    '/get': 'verified',
    '/get-options': 'verified',
    '/https-get': 'verified',
  });
});

// Fails if someone drops the CLI header only after Node built the call:
// headers given as an array (or with Expect) are written as the call is
// made, and the next service would learn the CLI's run and session.
it('never sends the CLI header on, even in headers Node writes at once', async () => {
  await application(
    async (request) => {
      const value = String(request.headers['x-agentrail-cli']);
      for (const call of [
        http.request(`${allowed.origin}/array`, {
          headers: [
            'Host',
            new URL(allowed.origin).host,
            'X-Agentrail-Cli',
            value,
          ],
        }),
        http.request(`${allowed.origin}/expect`, {
          method: 'PUT',
          headers: { 'x-agentrail-cli': value, expect: '100-continue' },
        }),
      ]) {
        call.end();
        await answered(call);
      }
    },
    { 'x-agentrail-cli': CLI_VALUE },
  );
  for (const path of ['/array', '/expect']) {
    expect(allowed.seen.get(path)?.headers).toBeDefined();
    expect(allowed.seen.get(path)?.headers['x-agentrail-cli']).toBeUndefined();
    // Written before the SDK could add one: no handoff, never a half one.
    expect(allowed.seen.get(path)?.handoff).toBe('missing');
  }
});

// Fails if someone drops the check on every ClientRequest Node builds: a
// call made through a function bound before init never reaches the
// wrappers, and would send a CLI's header and a handoff the server received
// on to the next service.
it("never sends the SDK's own headers on through a function bound before init", async () => {
  await application(
    async (request) => {
      const forwarded = {
        'x-agentrail-cli': String(request.headers['x-agentrail-cli']),
        [TRACE_HANDOFF_HEADER]: 'a-handoff-this-server-received',
      };
      const made = unwrapped.request(`${allowed.origin}/unwrapped-request`, {
        headers: forwarded,
      });
      made.end();
      await answered(made);
      await answered(
        unwrapped.get(`${allowed.origin}/unwrapped-get`, {
          headers: forwarded,
        }),
      );
    },
    { 'x-agentrail-cli': CLI_VALUE },
  );
  for (const path of ['/unwrapped-request', '/unwrapped-get']) {
    const { headers } = allowed.seen.get(path) ?? {};
    expect(headers).toBeDefined();
    expect(headers?.['x-agentrail-cli']).toBeUndefined();
    expect(headers?.[TRACE_HANDOFF_HEADER]).toBeUndefined();
  }
});
