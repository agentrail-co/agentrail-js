import {
  StructuredFieldError,
  parseDictionaryMembers,
  serializeDictionary,
  type BareItem,
  type Member,
} from './structured-fields.js';

/**
 * What a customer's CLI says about itself on each request to its own API:
 * the command being run, the run, the session it belongs to and the agent
 * running it. `agentrail-cli-sdk` writes it, and a server SDK or the edge
 * reads it into the request's step. One header, an RFC 9651 Dictionary:
 *
 * ```
 * x-agentrail-cli: v=1, sdk="0.3.0", cli="acme", cliv="2.3.1", run="0193f2c4-…",
 *   seq=3, ses="5f2c09d1…", sesfrom=agent, mode=agent, agent="claude-code",
 *   agentv="2.1.325", ev=("AI_AGENT"), cmd="deploy create"
 * ```
 *
 * Everything in it is the CLI's claim. A later version only adds members,
 * and never changes what one means, so a reader takes any version from 1 and
 * ignores the members it does not know.
 */
export const CLI_HEADER = 'x-agentrail-cli';

/** The version this package writes. */
const VERSION = 1;

/** How the run was started: by an agent, in CI, by a person at a terminal, or by a script. */
export const CLI_MODES = [
  'agent',
  'ci',
  'interactive',
  'non-interactive',
] as const;
export type CliMode = (typeof CLI_MODES)[number];

/**
 * Where the session came from: the agent's own session, the CI run, a local
 * session the CLI keeps for 30 minutes without a request, or this run alone
 * when it could keep none.
 */
export const CLI_SESSION_SOURCES = ['agent', 'ci', 'local', 'run'] as const;
export type CliSessionSource = (typeof CLI_SESSION_SOURCES)[number];

export interface CliHeader {
  /** The version of `agentrail-cli-sdk` that wrote it. */
  readonly sdkVersion: string;
  /** The CLI's name, as people type it: `acme`. */
  readonly cli: string;
  readonly cliVersion?: string | undefined;
  /** This run of the CLI: a UUID minted when the process started. */
  readonly run: string;
  /** This request's place among the run's requests, from 1. */
  readonly sequence: number;
  /**
   * The session, as 32 hex characters: a one-way hash of where it came
   * from, so an agent's own session id never leaves the process.
   */
  readonly session: string;
  readonly sessionFrom: CliSessionSource;
  readonly mode: CliMode;
  /** The agent running the CLI, as `claude-code` or `codex`. */
  readonly agent?: string | undefined;
  readonly agentVersion?: string | undefined;
  /** The names of the environment variables the agent or CI was told by. Never their values. */
  readonly evidence?: readonly string[] | undefined;
  /** The command, as its words were declared: `deploy create`. Never the arguments. */
  readonly command?: string | undefined;
}

/** A header value this package will not write: a CLI's bug, not a request's. */
export class CliHeaderInputError extends Error {
  override readonly name = 'CliHeaderInputError';
}

/** Printable ASCII, as an RFC 9651 String holds, of at most `max` characters. */
function text(max: number): RegExp {
  return new RegExp(`^[\\x20-\\x7e]{1,${max}}$`, 'u');
}

const SHORT_TEXT = text(64);
const COMMAND = text(128);
const RUN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SESSION = /^[0-9a-f]{32}$/u;
const AGENT = /^[a-z0-9._-]{1,64}$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const MAX_EVIDENCE = 8;
/** The largest Integer RFC 9651 holds. */
const MAX_INTEGER = 999_999_999_999_999;

function isMode(value: string): value is CliMode {
  return (CLI_MODES as readonly string[]).includes(value);
}

function isSessionSource(value: string): value is CliSessionSource {
  return (CLI_SESSION_SOURCES as readonly string[]).includes(value);
}

/** Why `header` is not one to send, or null when it is. */
function problemOf(header: CliHeader): string | null {
  if (!SHORT_TEXT.test(header.sdkVersion)) return 'sdkVersion';
  if (!SHORT_TEXT.test(header.cli)) return 'cli';
  if (header.cliVersion !== undefined && !SHORT_TEXT.test(header.cliVersion))
    return 'cliVersion';
  if (!RUN.test(header.run)) return 'run';
  if (
    !Number.isSafeInteger(header.sequence) ||
    header.sequence < 1 ||
    header.sequence > MAX_INTEGER
  )
    return 'sequence';
  if (!SESSION.test(header.session)) return 'session';
  if (!isSessionSource(header.sessionFrom)) return 'sessionFrom';
  if (!isMode(header.mode)) return 'mode';
  if (header.agent !== undefined && !AGENT.test(header.agent)) return 'agent';
  if (
    header.agentVersion !== undefined &&
    !SHORT_TEXT.test(header.agentVersion)
  )
    return 'agentVersion';
  if (
    header.evidence !== undefined &&
    (header.evidence.length === 0 ||
      header.evidence.length > MAX_EVIDENCE ||
      !header.evidence.every((name) => VARIABLE.test(name)))
  )
    return 'evidence';
  if (header.command !== undefined && !COMMAND.test(header.command))
    return 'command';
  return null;
}

const NO_PARAMETERS: ReadonlyMap<string, BareItem> = new Map();

function item(value: BareItem): Member {
  return { kind: 'item', value, parameters: NO_PARAMETERS };
}

function string(value: string): Member {
  return item({ kind: 'string', value });
}

/** The header's value for `header`. */
export function formatCliHeader(header: CliHeader): string {
  const problem = problemOf(header);
  if (problem !== null)
    throw new CliHeaderInputError(
      `The CLI header's ${problem} is not one it can carry.`,
    );
  const members = new Map<string, Member>([
    ['v', item({ kind: 'integer', value: VERSION })],
    ['sdk', string(header.sdkVersion)],
    ['cli', string(header.cli)],
  ]);
  if (header.cliVersion !== undefined)
    members.set('cliv', string(header.cliVersion));
  members.set('run', string(header.run));
  members.set('seq', item({ kind: 'integer', value: header.sequence }));
  members.set('ses', string(header.session));
  members.set('sesfrom', item({ kind: 'token', value: header.sessionFrom }));
  members.set('mode', item({ kind: 'token', value: header.mode }));
  if (header.agent !== undefined) members.set('agent', string(header.agent));
  if (header.agentVersion !== undefined)
    members.set('agentv', string(header.agentVersion));
  if (header.evidence !== undefined)
    members.set('ev', {
      kind: 'inner-list',
      items: header.evidence.map((name) => ({
        kind: 'item',
        value: { kind: 'string', value: name },
        parameters: NO_PARAMETERS,
      })),
      parameters: NO_PARAMETERS,
    });
  if (header.command !== undefined) members.set('cmd', string(header.command));
  return serializeDictionary(members);
}

function bareOf(member: Member | undefined): BareItem | undefined {
  return member?.kind === 'item' ? member.value : undefined;
}

function stringOf(member: Member | undefined): string | undefined {
  const value = bareOf(member);
  return value?.kind === 'string' ? value.value : undefined;
}

/**
 * What a request's header says, or null when it has none or one that is not
 * a CLI header of any version: not a Dictionary, a member missing, a member
 * this package would not write, or one given twice, as two header lines a
 * server joined into one value are.
 */
export function readCliHeader(value: string | null): CliHeader | null {
  if (value === null) return null;
  let written: [string, Member][];
  try {
    written = parseDictionaryMembers(value);
  } catch (error) {
    if (error instanceof StructuredFieldError) return null;
    throw error;
  }
  const members = new Map(written);
  if (members.size !== written.length) return null;
  const version = bareOf(members.get('v'));
  if (version?.kind !== 'integer' || version.value < 1) return null;
  const sequence = bareOf(members.get('seq'));
  const sessionFrom = bareOf(members.get('sesfrom'));
  const mode = bareOf(members.get('mode'));
  const evidence = members.get('ev');
  const sdkVersion = stringOf(members.get('sdk'));
  const cli = stringOf(members.get('cli'));
  const run = stringOf(members.get('run'));
  const session = stringOf(members.get('ses'));
  if (
    sequence?.kind !== 'integer' ||
    sessionFrom?.kind !== 'token' ||
    mode?.kind !== 'token' ||
    sdkVersion === undefined ||
    cli === undefined ||
    run === undefined ||
    session === undefined ||
    (evidence !== undefined && evidence.kind !== 'inner-list') ||
    (members.has('cliv') && stringOf(members.get('cliv')) === undefined) ||
    (members.has('agent') && stringOf(members.get('agent')) === undefined) ||
    (members.has('agentv') && stringOf(members.get('agentv')) === undefined) ||
    (members.has('cmd') && stringOf(members.get('cmd')) === undefined) ||
    !isSessionSource(sessionFrom.value) ||
    !isMode(mode.value)
  )
    return null;
  const names = evidence?.items.map((name) =>
    name.value.kind === 'string' ? name.value.value : null,
  );
  if (names?.includes(null)) return null;
  const header: CliHeader = {
    sdkVersion,
    cli,
    cliVersion: stringOf(members.get('cliv')),
    run,
    sequence: sequence.value,
    session,
    sessionFrom: sessionFrom.value,
    mode: mode.value,
    agent: stringOf(members.get('agent')),
    agentVersion: stringOf(members.get('agentv')),
    evidence: names?.filter((name) => name !== null),
    command: stringOf(members.get('cmd')),
  };
  return problemOf(header) === null ? header : null;
}
