import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCliHeader, type CliHeader } from 'agentrail-core';
import { afterEach } from 'vitest';

import {
  instrumentCli,
  type CliSdk,
  type CliSdkOptions,
} from '../../src/index.js';

/** A customer's API on this machine: it records the headers of each request it is sent. */
export interface Api {
  readonly origin: string;
  readonly requests: {
    readonly path: string;
    readonly headers: IncomingHttpHeaders;
  }[];
  /** What each request's header said, in order; null for one without it. */
  headers(): (CliHeader | null)[];
}

const servers: Server[] = [];
const sdks: CliSdk[] = [];
const folders: string[] = [];

afterEach(async () => {
  for (const sdk of sdks.splice(0)) sdk.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

/** Serves `200` to every path; `/redirect?to=<url>` answers with a redirect there. */
export async function startApi(): Promise<Api> {
  const requests: Api['requests'] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, headers: request.headers });
    const to = url.searchParams.get('to');
    if (url.pathname === '/redirect' && to !== null) {
      response.writeHead(302, { location: to }).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    headers: () =>
      requests.map(({ headers }) => {
        const value = headers['x-agentrail-cli'];
        return readCliHeader(typeof value === 'string' ? value : null);
      }),
  };
}

/** A folder of the test's own, removed after it. */
export function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'agentrail-cli-sdk-'));
  folders.push(folder);
  return folder;
}

/**
 * An environment with no agent, no CI and no switch in it, whose state
 * folders, on any platform, are under `home`: nothing the machine running
 * the tests has set reaches them.
 */
export function plainEnvironment(home: string): Record<string, string> {
  return {
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_RUNTIME_DIR: join(home, 'runtime'),
    LOCALAPPDATA: join(home, 'local'),
    TEMP: join(home, 'tmp'),
  };
}

/** An instrumented CLI, closed after the test. */
export function instrument(options: CliSdkOptions): CliSdk {
  const sdk = instrumentCli(options);
  sdks.push(sdk);
  return sdk;
}
