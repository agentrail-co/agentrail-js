import { get } from 'node:http';
import { channel } from 'node:diagnostics_channel';

import { describe, expect, it, vi } from 'vitest';

import { watchRequests } from '../src/requests.js';

import {
  instrument,
  plainEnvironment,
  startApi,
  temporaryFolder,
} from './support/api.js';

/** A request through `http.get`, as axios, got and node-fetch make theirs. */
function httpGet(
  url: string,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, { headers }, (response) => {
      response.resume();
      response.on('end', resolve);
    }).on('error', reject);
  });
}

describe('the CLI’s requests', () => {
  // Fails if someone stops watching one of Node's two request channels:
  // the CLIs whose API client is built on that one would send no header.
  it('carry the header to a listed origin, through fetch and through http', async () => {
    const api = await startApi();
    instrument({
      name: 'acme',
      version: '2.3.1',
      origins: [api.origin],
      env: plainEnvironment(temporaryFolder()),
    });
    await fetch(`${api.origin}/v1/deployments`);
    await httpGet(`${api.origin}/v1/projects`);
    const [first, second] = api.headers();
    expect(first).toMatchObject({
      cli: 'acme',
      cliVersion: '2.3.1',
      sequence: 1,
    });
    expect(second).toMatchObject({
      sequence: 2,
      run: first?.run,
      session: first?.session,
    });
  });

  // Fails if someone matches origins loosely or puts the header on at the
  // client: an agent's run, its session and its command would reach a
  // third party's API, or the server a listed one redirects to.
  it('never carry it to another origin, after a redirect either', async () => {
    const api = await startApi();
    const other = await startApi();
    instrument({
      name: 'acme',
      origins: [api.origin],
      env: plainEnvironment(temporaryFolder()),
    });
    await fetch(`${other.origin}/v1`);
    await httpGet(`${other.origin}/v1`);
    await fetch(
      `${api.origin}/redirect?to=${encodeURIComponent(`${other.origin}/landed`)}`,
    );
    expect(api.headers()).toHaveLength(1);
    expect(api.headers()[0]).not.toBeNull();
    expect(other.requests.map(({ path }) => path)).toEqual([
      '/v1',
      '/v1',
      '/landed',
    ]);
    expect(other.headers()).toEqual([null, null, null]);
  });

  // Fails if someone leaves a header the CLI put on itself to the redirect:
  // fetch keeps a request's headers when it follows one, so a download link
  // to a storage host would carry the run, the session and the command.
  it.each([
    ['added by the SDK', true],
    ['the CLI puts on itself', false],
  ])(
    'never follow a redirect elsewhere, with the header %s',
    async (_label, watch) => {
      const api = await startApi();
      const storage = await startApi();
      const sdk = instrument({
        name: 'acme',
        origins: [api.origin],
        env: plainEnvironment(temporaryFolder()),
        watchRequests: watch,
      });
      const url = `${api.origin}/redirect?to=${encodeURIComponent(`${storage.origin}/file`)}`;
      await fetch(url, { headers: sdk.headers(url) });
      expect(api.headers()[0]).not.toBeNull();
      expect(storage.requests.map(({ path }) => path)).toEqual(['/file']);
      expect(storage.requests[0]?.headers['x-agentrail-cli']).toBeUndefined();
    },
  );

  // Fails if someone takes an http request's origin from its Host header:
  // a request made to any server with a Host header naming the CLI's API
  // would carry the run, the session and the command there.
  it('never carry it to a server a Host header names as the API', async () => {
    const api = await startApi();
    const other = await startApi();
    // The API by name, the other server by address: the Host header can name
    // the API while the request goes to the other one.
    const listed = api.origin.replace('127.0.0.1', 'localhost');
    const sdk = instrument({
      name: 'acme',
      origins: [listed],
      env: plainEnvironment(temporaryFolder()),
    });
    const host = new URL(listed).host;
    await httpGet(`${other.origin}/forged`, { host });
    await httpGet(`${other.origin}/forged`, {
      host,
      ...sdk.headers(`${listed}/v1`),
    });
    expect(other.requests.map(({ path }) => path)).toEqual([
      '/forged',
      '/forged',
    ]);
    expect(other.headers()).toEqual([null, null]);
  });

  // Fails if someone lets a throwing onError out of a request hook: Node
  // throws a subscriber's error again outside the request, and the CLI's
  // command would end because its own error handler has a bug.
  it('go out when the CLI’s onError throws as well', async () => {
    const api = await startApi();
    const stop = watchRequests(
      {
        lists: () => true,
        header: () => {
          throw new Error('broken');
        },
      },
      () => {
        throw new Error('the CLI’s handler is broken too');
      },
    );
    const uncaught: unknown[] = [];
    const record = (error: unknown) => uncaught.push(error);
    process.on('uncaughtException', record);
    try {
      expect((await fetch(`${api.origin}/v1`)).status).toBe(200);
      await httpGet(`${api.origin}/v2`);
      // A subscriber's error is thrown again on the next tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      stop();
      process.off('uncaughtException', record);
    }
    expect(api.requests).toHaveLength(2);
    expect(uncaught).toEqual([]);
  });

  // Fails if someone takes the header off by one SDK's own origins: with
  // two in one CLI (its own and a plugin's), each would strip the other's.
  it('keep the header another SDK in the process put on for its own API', async () => {
    const api = await startApi();
    const plugin = await startApi();
    const env = plainEnvironment(temporaryFolder());
    instrument({ name: 'acme', origins: [api.origin], env });
    instrument({ name: 'acme-plugin', origins: [plugin.origin], env });
    await fetch(`${api.origin}/v1`);
    await fetch(`${plugin.origin}/v1`);
    expect(api.headers()[0]?.cli).toBe('acme');
    expect(plugin.headers()[0]?.cli).toBe('acme-plugin');
  });

  // Fails if someone reads DO_NOT_TRACK as Layer 2's switch alone, or
  // ignores the CLI's own setting: a person who turned tracking off would
  // still be followed.
  it('carry nothing when DO_NOT_TRACK is set or the CLI turned it off', async () => {
    const api = await startApi();
    const env = plainEnvironment(temporaryFolder());
    const untracked = instrument({
      name: 'acme',
      origins: [api.origin],
      env: { ...env, DO_NOT_TRACK: '1' },
    });
    const off = instrument({
      name: 'acme',
      origins: [api.origin],
      env,
      enabled: false,
    });
    await fetch(`${api.origin}/v1`);
    expect(api.headers()).toEqual([null]);
    expect([untracked.enabled, off.enabled]).toEqual([false, false]);
    expect(untracked.headers(api.origin)).toEqual({});
  });

  // Fails if someone adds the header again where the CLI put it itself: a
  // request would carry two values, and a reader takes neither.
  it('carry one header when the CLI puts it on itself', async () => {
    const api = await startApi();
    const sdk = instrument({
      name: 'acme',
      origins: [api.origin],
      env: plainEnvironment(temporaryFolder()),
    });
    await fetch(`${api.origin}/v1`, {
      headers: sdk.headers(`${api.origin}/v1`),
    });
    expect(api.requests[0]?.headers['x-agentrail-cli']).toMatch(/^v=1, /u);
    expect(api.headers()).toHaveLength(1);
    expect(api.headers()[0]?.sequence).toBe(1);
  });

  // Fails if someone lets a failure out of a request hook: Node throws a
  // subscriber's error again outside the request, and the CLI would crash.
  it('go out as they were when the header fails, and onError is told', async () => {
    const api = await startApi();
    const report = vi.fn<(error: Error) => void>();
    const stop = watchRequests(
      {
        lists: () => true,
        header: () => {
          throw new Error('broken');
        },
      },
      report,
    );
    try {
      const response = await fetch(`${api.origin}/v1`);
      await httpGet(`${api.origin}/v2`);
      expect(response.status).toBe(200);
    } finally {
      stop();
    }
    expect(report).toHaveBeenCalledTimes(2);
    expect(api.headers()).toEqual([null, null]);
  });

  // Fails if close() leaves a subscriber behind, or headers() on: a CLI
  // that turns telemetry off mid-run would still send the header.
  it('carry nothing once the SDK is closed', async () => {
    const api = await startApi();
    const sdk = instrument({
      name: 'acme',
      origins: [api.origin],
      env: plainEnvironment(temporaryFolder()),
    });
    sdk.close();
    await fetch(`${api.origin}/v1`);
    expect(api.headers()).toEqual([null]);
    expect([sdk.enabled, sdk.headers(`${api.origin}/v1`)]).toEqual([false, {}]);
    expect(channel('undici:request:create').hasSubscribers).toBe(false);
  });
});
