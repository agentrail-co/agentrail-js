import { CLI_HEADER_CONTRACT } from 'agentrail-contract';
import { describe, expect, it } from 'vitest';

import {
  CLI_HEADER,
  CliHeaderInputError,
  formatCliHeader,
  readCliHeader,
  type CliHeader,
} from '../src/index.js';

const FULL: CliHeader = {
  sdkVersion: '0.3.0',
  cli: 'acme',
  cliVersion: '2.3.1',
  run: '0193f2c4-7a1b-7c3d-8e4f-0123456789ab',
  sequence: 3,
  session: '5f2c09d1aa0b4c3e9d8f7e6d5c4b3a29',
  sessionFrom: 'agent',
  mode: 'agent',
  agent: 'claude-code',
  agentVersion: '2.1.325',
  evidence: ['AI_AGENT', 'CLAUDECODE'],
  command: 'deploy create',
};

const MINIMAL: CliHeader = {
  sdkVersion: '0.3.0',
  cli: 'acme',
  run: FULL.run,
  sequence: 1,
  session: FULL.session,
  sessionFrom: 'local',
  mode: 'interactive',
};

describe('the CLI header', () => {
  // Fails if someone changes a member's key, type or order: the Go and
  // Python CLI SDKs write this same value for this same input.
  it('is written as the contract fixes it', () => {
    expect(formatCliHeader(FULL)).toBe(
      'v=1, sdk="0.3.0", cli="acme", cliv="2.3.1", run="0193f2c4-7a1b-7c3d-8e4f-0123456789ab", seq=3, ' +
        'ses="5f2c09d1aa0b4c3e9d8f7e6d5c4b3a29", sesfrom=agent, mode=agent, agent="claude-code", ' +
        'agentv="2.1.325", ev=("AI_AGENT" "CLAUDECODE"), cmd="deploy create"',
    );
  });

  // Fails if the reader and the writer disagree on a member, or the writer
  // stops escaping a quote: a server SDK would read another command than
  // the one the CLI ran, or nothing at all.
  it('reads back what it writes, quotes and backslashes too', () => {
    expect(readCliHeader(formatCliHeader(FULL))).toEqual(FULL);
    expect(readCliHeader(formatCliHeader(MINIMAL))).toEqual(MINIMAL);
    const quoted = { ...MINIMAL, cliVersion: '1.0 "beta" \\ x' };
    expect(readCliHeader(formatCliHeader(quoted))).toEqual(quoted);
  });

  // Fails if someone makes the reader refuse a version it does not know: a
  // server SDK would drop every request from a newer CLI, and CLIs on
  // people's machines are upgraded long after servers are.
  it('reads a later version, ignoring the members it does not know', () => {
    const later = formatCliHeader(FULL)
      .replace('v=1', 'v=2')
      .concat(', flags=("json"), future=?1');
    expect(readCliHeader(later)).toEqual(FULL);
  });

  // Fails if someone loosens the reader: a header that is not one the SDK
  // writes, a raw session id say, would reach the linker as a session.
  it('reads nothing from a header no CLI SDK writes', () => {
    const valid = formatCliHeader(MINIMAL);
    for (const header of [
      null,
      '',
      'not a dictionary',
      valid.replace('v=1', 'v=0'),
      valid.replace(/, ses="[0-9a-f]+"/u, ''),
      valid.replace(/ses="[0-9a-f]+"/u, 'ses="CLAUDE_CODE_SESSION_ID=abc"'),
      valid.replace('mode=interactive', 'mode=robot'),
      valid.replace('sesfrom=local', 'sesfrom="local"'),
      valid.replace('seq=1', 'seq=0'),
      `${valid}, ev="AI_AGENT"`,
      `${valid}, ev=(1 2)`,
      `${valid}, cmd=deploy`,
      // Two header lines, as a server joins them: neither is read.
      `${valid}, ${valid}`,
    ])
      expect(readCliHeader(header)).toBeNull();
  });

  // Fails if someone lets the writer through with text a header cannot
  // carry: Node throws on such a header, and the CLI's request would fail.
  it('refuses to write what a header cannot carry', () => {
    for (const header of [
      { ...MINIMAL, cli: 'acmé' },
      { ...MINIMAL, command: 'deploy\ncreate' },
      { ...MINIMAL, agent: 'Claude Code' },
      { ...MINIMAL, evidence: [] },
      { ...MINIMAL, session: 'raw-session-id' },
    ])
      expect(() => formatCliHeader(header)).toThrow(CliHeaderInputError);
  });

  // Fails if this package and the contract part: the Go and Python SDKs
  // read and write the header by the contract's vectors, so a CLI and a
  // server in different languages would disagree on what a header says.
  it('writes and reads the contract’s vectors', () => {
    const { header, later, unread } = CLI_HEADER_CONTRACT.vectors;
    expect(CLI_HEADER_CONTRACT.header).toBe(CLI_HEADER);
    expect(formatCliHeader(header.reads as CliHeader)).toBe(header.value);
    expect(readCliHeader(header.value)).toEqual(header.reads);
    expect(readCliHeader(later.value)).toEqual(later.reads);
    for (const value of unread) expect(readCliHeader(value)).toBeNull();
  });
});
