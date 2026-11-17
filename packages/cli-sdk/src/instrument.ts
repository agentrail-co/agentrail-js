import { isatty } from 'node:tty';

import {
  CLI_HEADER,
  VERSION,
  formatCliHeader,
  newSessionId,
  type CliMode,
  type CliSessionSource,
} from 'agentrail-core';

import { detectAgent, type Environment } from './agents.js';
import { detectCi } from './ci.js';
import {
  commandOf,
  commanderWords,
  oclifWords,
  yargsWords,
  type CommanderProgram,
  type OclifPrerun,
} from './commands.js';
import { watchRequests } from './requests.js';
import { LocalSession, sessionKey, stateFolders } from './session.js';

export interface CliSdkOptions {
  /** The CLI's name, as people type it: `acme`. */
  readonly name: string;
  /** The CLI's own version: `2.3.1`. */
  readonly version?: string;
  /**
   * The exact origins of your own API, as `https://api.acme.com`: only
   * requests to these get the header. Never list an origin you do not run.
   */
  readonly origins: readonly string[];
  /**
   * False turns everything off: wire your CLI's own telemetry setting here.
   * `DO_NOT_TRACK` set turns everything off whatever this says.
   */
  readonly enabled?: boolean;
  /**
   * Tools of yours that should share a session in one agent session (a
   * second CLI, a stdio MCP server) give the same scope; the CLI's name
   * when absent.
   */
  readonly sessionScope?: string;
  /**
   * False adds the header to no request: the CLI puts `headers(url)` on
   * its requests itself, as in Bun or Deno, which publish no request
   * channels. In Node, requests are watched still, so the header never
   * follows a redirect to an origin not listed. True by default.
   */
  readonly watchRequests?: boolean;
  /** Told what failed to be recorded; the CLI's command goes on. `console.error` by default. */
  readonly onError?: (error: Error) => void;
  /** The environment to read; `process.env` by default. */
  readonly env?: Environment;
}

/** Options the SDK cannot run with: a bug in the CLI, found the first time it runs. */
export class ConfigurationError extends Error {
  override readonly name = 'AgentrailConfigurationError';
}

export interface CliAgent {
  /** As `claude-code` or `codex`. */
  readonly id: string;
  readonly version?: string | undefined;
}

export interface CliSdk {
  /** False when `enabled` was false, `DO_NOT_TRACK` is set, or after `close()`: no request gets the header. */
  readonly enabled: boolean;
  /**
   * How this run was started. Read it to answer an agent as it reads best,
   * in JSON with no prompts, say; it is known whether or not the SDK is on.
   */
  readonly mode: CliMode;
  /** The agent running the CLI, or null when nothing says one is. */
  readonly agent: CliAgent | null;
  /**
   * The header for a request to `url`, to spread into its headers; empty
   * when the SDK is off or `url` is not on one of the listed origins.
   */
  headers(url: string | URL): Record<string, string>;
  /** Names the command being run, for a framework with no adapter here: `command('deploy create')`. */
  command(words: string | readonly string[]): void;
  /** Names each command commander runs. Returns the program. */
  commander<Program extends CommanderProgram>(program: Program): Program;
  /** yargs middleware naming each command yargs runs: `.middleware(agentrail.yargs)`. */
  readonly yargs: (argv: unknown, instance?: unknown) => void;
  /** An oclif `prerun` hook naming each command oclif runs: `export default agentrail.oclif`. */
  readonly oclif: (options: OclifPrerun) => Promise<void>;
  /** Turns the SDK off for the rest of the run, as `enabled: false` would have. */
  close(): void;
}

const TEXT = /^[\x20-\x7e]{1,64}$/u;
const MAX_EVIDENCE = 8;

/** A switch such as `DO_NOT_TRACK` that is on whenever it is set, except to `0` or `false`. */
function isOn(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized !== '' &&
    normalized !== '0' &&
    normalized !== 'false'
  );
}

function exactOrigins(origins: readonly string[]): Set<string> {
  if (origins.length === 0)
    throw new ConfigurationError(
      'List the origins of your API in origins, as https://api.example.com.',
    );
  return new Set(
    origins.map((origin) => {
      let url: URL;
      try {
        url = new URL(origin);
      } catch (error) {
        if (error instanceof TypeError)
          throw new ConfigurationError(`${origin} is not a URL.`, {
            cause: error,
          });
        throw error;
      }
      if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
        throw new ConfigurationError(
          `origins must hold exact http(s) origins, as https://api.example.com: not ${origin}.`,
        );
      // The URL parser takes `*` in a host, and no request is ever made to one.
      if (url.hostname.includes('*'))
        throw new ConfigurationError(
          `origins are matched exactly: list each one, not ${origin}.`,
        );
      return origin;
    }),
  );
}

function text(value: string, option: string): string {
  if (!TEXT.test(value) || value.trim() !== value)
    throw new ConfigurationError(
      `${option} must be 1 to 64 printable ASCII characters, with no space at either end.`,
    );
  return value;
}

/**
 * Starts recording the CLI's run: call it once, first thing, before the CLI
 * parses its arguments or makes a request. It reads only the environment;
 * nothing is sent anywhere but on the CLI's own requests to its own API.
 */
export function instrumentCli(options: CliSdkOptions): CliSdk {
  const env = options.env ?? process.env;
  const name = text(options.name, 'name');
  const version =
    options.version === undefined
      ? undefined
      : text(options.version, 'version');
  const scope =
    options.sessionScope === undefined
      ? name
      : text(options.sessionScope, 'sessionScope');
  const origins = exactOrigins(options.origins);
  const onError =
    options.onError ??
    ((error: Error) => {
      console.error('agentrail-cli-sdk:', error);
    });
  const debug = isOn(env.AGENTRAIL_CLI_DEBUG)
    ? (line: string) => process.stderr.write(`agentrail-cli-sdk: ${line}\n`)
    : undefined;

  const agent = detectAgent(env);
  const ci = detectCi(env);
  const mode: CliMode =
    agent !== null
      ? 'agent'
      : ci !== null
        ? 'ci'
        : isatty(0) || isatty(1)
          ? 'interactive'
          : 'non-interactive';
  const evidence = [
    ...(agent?.evidence ?? []),
    ...(ci === null ? [] : [ci.evidence]),
  ].slice(0, MAX_EVIDENCE);
  let enabled = options.enabled !== false && !isOn(env.DO_NOT_TRACK);
  const run = newSessionId(Date.now());

  let command: string | undefined;
  let sequence = 0;
  let session:
    | { key: string; from: CliSessionSource; local: LocalSession | null }
    | undefined;

  /** Where the run's session comes from: the agent's, the CI run's, one kept on this machine, or the run's own. */
  const openSession = (now: number): NonNullable<typeof session> => {
    if (agent?.session !== undefined) {
      const source = `${agent.session.name}=${agent.session.value}`;
      return {
        key: sessionKey(scope, 'agent', source),
        from: 'agent',
        local: null,
      };
    }
    if (ci?.run !== undefined)
      return { key: sessionKey(scope, 'ci', ci.run), from: 'ci', local: null };
    // A CI job's home is thrown away with it: the session is the run's own.
    // A person's runs and each agent's are kept apart: one machine, many sessions.
    const local =
      ci === null
        ? LocalSession.open(
            stateFolders(env, process.platform),
            `${scope}\0${agent?.id ?? ''}`,
            now,
            onError,
          )
        : null;
    return local === null
      ? { key: sessionKey(scope, 'run', run), from: 'run', local: null }
      : { key: sessionKey(scope, 'local', local.id), from: 'local', local };
  };

  /** The run's session, worked out on its first request: a CLI that makes none writes no file. */
  const sessionNow = (now: number) => {
    if (session === undefined) session = openSession(now);
    else session.local?.touch(now);
    return session;
  };

  const skipped = (origin: string): void => {
    debug?.(`no header for ${origin}: not one of the origins.`);
  };

  /** The header for a request to a listed origin. */
  const headerFor = (origin: string): string => {
    const { key, from } = sessionNow(Date.now());
    sequence += 1;
    const value = formatCliHeader({
      sdkVersion: VERSION,
      cli: name,
      cliVersion: version,
      run,
      sequence,
      session: key,
      sessionFrom: from,
      mode,
      agent: agent?.id,
      agentVersion: agent?.version,
      evidence: evidence.length === 0 ? undefined : evidence,
      command,
    });
    debug?.(`x-agentrail-cli for ${origin}: ${value}`);
    return value;
  };

  if (!enabled)
    debug?.(
      options.enabled === false
        ? 'off: enabled is false.'
        : 'off: DO_NOT_TRACK is set.',
    );
  // Watched even when the CLI puts the header on itself: a redirect to an
  // unlisted origin would carry it there.
  const add = options.watchRequests !== false;
  const stop = enabled
    ? watchRequests(
        {
          lists: (origin) => origins.has(origin),
          header: (origin) => (add ? headerFor(origin) : null),
          skipped,
        },
        onError,
      )
    : undefined;

  const setCommand = (words: readonly string[]) => {
    command = commandOf(words);
  };
  let yargsReported = false;

  return {
    get enabled() {
      return enabled;
    },
    mode,
    agent: agent === null ? null : { id: agent.id, version: agent.version },
    headers(url) {
      if (!enabled) return {};
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch (error) {
        if (error instanceof TypeError) return {};
        throw error;
      }
      if (!origins.has(origin)) {
        skipped(origin);
        return {};
      }
      try {
        return { [CLI_HEADER]: headerFor(origin) };
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return {};
      }
    },
    command(words) {
      setCommand(
        typeof words === 'string' ? words.trim().split(/\s+/u) : words,
      );
    },
    commander(program) {
      program.hook('preAction', (_thisCommand, actionCommand) => {
        setCommand(commanderWords(actionCommand));
      });
      return program;
    },
    yargs: (_argv, instance) => {
      const words = yargsWords(instance);
      if (words === null && !yargsReported) {
        yargsReported = true;
        onError(
          new Error(
            "This yargs keeps no matched commands where yargs 17 and 18 do: the header names no command. Name it with command('…').",
          ),
        );
      }
      setCommand(words ?? []);
    },
    oclif: (prerun) => {
      setCommand(oclifWords(prerun));
      return Promise.resolve();
    },
    close() {
      enabled = false;
      stop?.();
    },
  };
}
