import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CLI_HEADER_CONTRACT } from 'agentrail-contract';
import type { CliSessionSource } from 'agentrail-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionFileName, sessionKey, stateFolders } from '../src/session.js';

import {
  instrument,
  plainEnvironment,
  startApi,
  temporaryFolder,
} from './support/api.js';

const CLAUDE = {
  AI_AGENT: 'claude-code_2-1-325_agent',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: '3f1c9a52-0d4e-4c55-9f7a-2b8e6d1c0a77',
};

afterEach(() => {
  vi.useRealTimers();
});

const START = Date.parse('2026-11-16T09:00:00Z');

/** A run of `acme` in `env` whose requests are made at the minutes given, from START. */
async function startRun(env: Record<string, string>) {
  const api = await startApi();
  const sdk = instrument({ name: 'acme', origins: [api.origin], env });
  return {
    async requestAt(minutes: number) {
      vi.setSystemTime(START + minutes * 60_000);
      await fetch(`${api.origin}/v1`);
      const header = api.headers().at(-1);
      if (header === null || header === undefined)
        throw new Error('No header was sent.');
      return header.session;
    },
    end: () => {
      sdk.close();
    },
  };
}

/** The session one run of `acme` in `env` sends its API. */
async function sessionOfRun(
  env: Record<string, string>,
  sessionScope?: string,
) {
  const api = await startApi();
  const sdk = instrument({
    name: 'acme',
    origins: [api.origin],
    env,
    ...(sessionScope === undefined ? {} : { sessionScope }),
  });
  await fetch(`${api.origin}/v1`);
  sdk.close();
  const header = api.headers()[0];
  if (header === null || header === undefined)
    throw new Error('No header was sent.');
  return { header, raw: api.requests[0]?.headers['x-agentrail-cli'] };
}

describe('the session', () => {
  // Fails if someone sends the agent's session id, or hashes it without the
  // scope: the agent's own id would leave the machine, or two companies'
  // CLIs in one agent session would send one value they could match.
  it('is the agent’s, hashed with the CLI’s scope', async () => {
    const home = temporaryFolder();
    const env = { ...plainEnvironment(home), ...CLAUDE };
    const first = await sessionOfRun(env);
    const second = await sessionOfRun(env);
    const otherCompany = await sessionOfRun(env, 'other-company');
    expect(first.header).toMatchObject({
      mode: 'agent',
      agent: 'claude-code',
      agentVersion: '2.1.325',
      sessionFrom: 'agent',
      session: sessionKey(
        'acme',
        'agent',
        `CLAUDE_CODE_SESSION_ID=${CLAUDE.CLAUDE_CODE_SESSION_ID}`,
      ),
    });
    expect(second.header.session).toBe(first.header.session);
    expect(second.header.run).not.toBe(first.header.run);
    expect(otherCompany.header.session).not.toBe(first.header.session);
    expect(first.raw).not.toContain(CLAUDE.CLAUDE_CODE_SESSION_ID);
    // An agent names its session: nothing is kept on the machine.
    expect(readdirSync(home)).toEqual([]);
  });

  // Fails if someone keeps a local session in CI: every job on a shared
  // runner would write one, and the run would not be the session.
  it('is the CI run’s in CI, and nothing is written', async () => {
    const home = temporaryFolder();
    const env = {
      ...plainEnvironment(home),
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
    };
    const { header } = await sessionOfRun(env);
    expect(header).toMatchObject({
      mode: 'ci',
      sessionFrom: 'ci',
      evidence: ['GITHUB_ACTIONS'],
    });
    // A service whose run cannot be read: the run's own session, still nothing written.
    const unnamed = await sessionOfRun({
      ...plainEnvironment(home),
      TF_BUILD: 'True',
    });
    expect(unnamed.header).toMatchObject({ mode: 'ci', sessionFrom: 'run' });
    expect(readdirSync(home)).toEqual([]);
  });

  // Fails if someone drops the idle timeout or the day's cap: a person's
  // commands hours apart, or on two days, would read as one journey.
  it('is kept on the machine for 30 minutes without a request, and a day at most', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-11-16T09:00:00Z');
    const env = plainEnvironment(temporaryFolder());
    const at = async (minutes: number) => {
      vi.setSystemTime(start + minutes * 60_000);
      return (await sessionOfRun(env)).header;
    };
    const first = await at(0);
    expect(first.sessionFrom).toBe('local');
    // Each run's request keeps the session going: every 25 minutes, all day.
    const kept = [first.session];
    for (let minutes = 25; minutes < 24 * 60; minutes += 25)
      kept.push((await at(minutes)).session);
    expect(new Set(kept).size).toBe(1);
    const nextDay = await at(24 * 60 + 5);
    const afterIdle = await at(24 * 60 + 5 + 31);
    expect(
      new Set([first.session, nextDay.session, afterIdle.session]).size,
    ).toBe(3);
  });

  // Fails if someone lets an unwritable folder end the run, or report it as
  // a failure: Claude Code's sandbox and read-only containers are normal.
  it('goes on in the next folder, or as the run’s own, where a folder cannot be written', async () => {
    /** A home where `blocked` are files: nothing can be written under them. */
    const homeBlocking = (blocked: readonly string[]) => {
      const home = temporaryFolder();
      for (const name of blocked) writeFileSync(join(home, name), '');
      return plainEnvironment(home);
    };
    const report = vi.fn<(error: Error) => void>();
    const api = await startApi();
    // Each platform's first folder blocked: the second is taken.
    const first = instrument({
      name: 'acme',
      origins: [api.origin],
      env: homeBlocking(['Library', 'state', 'local']),
      onError: report,
    });
    await fetch(`${api.origin}/v1`);
    expect(api.headers()[0]?.sessionFrom).toBe('local');
    first.close();

    instrument({
      name: 'acme',
      origins: [api.origin],
      env: homeBlocking(['Library', 'state', 'local', 'tmp', 'runtime']),
      onError: report,
    });
    await fetch(`${api.origin}/v2`);
    expect(api.headers()[1]?.sessionFrom).toBe('run');
    expect(report).not.toHaveBeenCalled();
  });

  // Fails if someone changes how the session or its file is named: the Go
  // and Python CLI SDKs and the stdio MCP adapter derive the contract's
  // values, so one company's tools in one agent session would not share it.
  it('is derived as the contract says every SDK derives it', () => {
    const { sessionKeys, sessionFiles } = CLI_HEADER_CONTRACT.vectors;
    for (const { scope, from, source, key } of sessionKeys)
      expect(sessionKey(scope, from as CliSessionSource, source)).toBe(key);
    for (const { scope, agent, file } of sessionFiles)
      expect(sessionFileName(`${scope}\0${agent ?? ''}`)).toBe(file);
  });

  // Fails if someone keys the local session by the CLI alone: a person's
  // commands and an agent's on one machine (Gemini CLI and Cursor give no
  // session id) would be one journey, and two agents' would be too.
  it('is a person’s own, and each agent’s own, on one machine', async () => {
    const env = plainEnvironment(temporaryFolder());
    const person = await sessionOfRun(env);
    const gemini = await sessionOfRun({ ...env, GEMINI_CLI: '1' });
    const cursor = await sessionOfRun({ ...env, CURSOR_AGENT: '1' });
    const personAgain = await sessionOfRun(env);
    const geminiAgain = await sessionOfRun({ ...env, GEMINI_CLI: '1' });
    expect(
      new Set([person, gemini, cursor].map(({ header }) => header.session))
        .size,
    ).toBe(3);
    expect(personAgain.header.session).toBe(person.header.session);
    expect(geminiAgain.header).toMatchObject({
      session: gemini.header.session,
      sessionFrom: 'local',
      mode: 'agent',
    });
  });

  // Fails if someone stops a long run from writing that its session is in
  // use: a command that polls for 40 minutes would leave the next run, five
  // minutes later, a session idle since the poll began.
  it('is kept going by a long run’s requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const env = plainEnvironment(temporaryFolder());
    const long = await startRun(env);
    const session = await long.requestAt(0);
    for (let minutes = 5; minutes <= 40; minutes += 5)
      await long.requestAt(minutes);
    long.end();
    const next = await startRun(env);
    expect(await next.requestAt(45)).toBe(session);
  });

  // Fails if someone lets a run that went idle write its session back: a run
  // started after the idle timeout begins a new session, and the idle run's
  // next request would put the old one back over it, splitting every run
  // after from the new one.
  it('is not written back over a newer one by a run that went idle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const env = plainEnvironment(temporaryFolder());
    const idle = await startRun(env);
    const old = await idle.requestAt(0);
    const newer = await startRun(env);
    const started = await newer.requestAt(31);
    expect(started).not.toBe(old);
    // The idle run goes on with its own session, and writes nothing back.
    expect(await idle.requestAt(32)).toBe(old);
    const later = await startRun(env);
    expect(await later.requestAt(33)).toBe(started);
  });

  // Fails if someone lets a run older than a day write its session back:
  // every run after it would find an expired session and start another.
  it('is not written back by a run that outlived it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const env = plainEnvironment(temporaryFolder());
    const day = 24 * 60;
    const long = await startRun(env);
    const old = await long.requestAt(0);
    for (let minutes = 25; minutes < day; minutes += 25)
      await long.requestAt(minutes);
    const next = await startRun(env);
    const fresh = await next.requestAt(day + 2);
    expect(await long.requestAt(day + 4)).toBe(old);
    const later = await startRun(env);
    expect(await later.requestAt(day + 6)).toBe(fresh);
    expect(fresh).not.toBe(old);
  });

  // Fails if someone takes a relative or empty folder variable: the session
  // file would be written into whatever folder the CLI was run in, a
  // repository say.
  it('is kept only in folders named by absolute paths', () => {
    expect(
      stateFolders(
        { HOME: '/home/ada', XDG_STATE_HOME: 'state', XDG_RUNTIME_DIR: '' },
        'linux',
      ),
    ).toEqual(['/home/ada/.local/state/agentrail']);
    expect(stateFolders({ HOME: '.', TMPDIR: 'tmp' }, 'darwin')).toEqual([]);
  });
});
