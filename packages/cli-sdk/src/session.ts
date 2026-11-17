import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  newSessionId,
  sessionStartOf,
  type CliSessionSource,
} from 'agentrail-core';

import type { Environment } from './agents.js';

/**
 * The session a run belongs to, as the header's `ses`: 32 hex characters of
 * SHA-256 over where it came from. The agent's own session id never leaves
 * the process, and the scope (the CLI's name, unless the CLI names another)
 * keeps two companies' CLIs run in one agent session from sending one
 * value that could be matched across them. Every CLI SDK and the server
 * SDK's stdio MCP adapter derive it alike, so one company's tools in one
 * agent session share it.
 */
export function sessionKey(
  scope: string,
  from: CliSessionSource,
  source: string,
): string {
  return createHash('sha256')
    .update(`agentrail-cli-session\0${scope}\0${from}\0${source}`)
    .digest('hex')
    .slice(0, 32);
}

/** A local session ends after 30 minutes without a request, as the engine's do. */
const IDLE_MS = 30 * 60 * 1000;
/** And lasts a day at most, as the session cookie does. */
const MAX_LENGTH_MS = 24 * 60 * 60 * 1000;
/** How often a long run writes that its session is still in use. */
const REFRESH_MS = 60 * 1000;

/** The errors of a folder the CLI may not or cannot write: a sandbox, a read-only home, a full disk. */
const UNWRITABLE = new Set([
  'EACCES',
  'EPERM',
  'EROFS',
  'ENOSPC',
  'EDQUOT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'ENOENT',
]);

function codeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

/** A state file another process could not have written whole, or one that is not a session. */
export class LocalSessionError extends Error {
  override readonly name = 'AgentrailLocalSessionError';
}

/** A folder a variable names, when it names one by an absolute path: the XDG spec ignores the rest. */
function absolute(folder: string | undefined): string | undefined {
  return folder !== undefined && isAbsolute(folder) ? folder : undefined;
}

/**
 * Folders a local session may be kept in, the user's own first: where the
 * platform keeps an application's state, then a temporary folder only this
 * user can write (macOS and Windows give each user one; on Linux,
 * `XDG_RUNTIME_DIR`). Never a shared `/tmp`, where another user could plant
 * a session, and never a relative path, which would write into the folder
 * the CLI was run in.
 */
export function stateFolders(
  env: Environment,
  platform: NodeJS.Platform,
): string[] {
  const home = absolute(env.HOME);
  const folders =
    platform === 'win32'
      ? [absolute(env.LOCALAPPDATA), absolute(env.TEMP)]
      : platform === 'darwin'
        ? [
            home === undefined
              ? undefined
              : join(home, 'Library', 'Application Support'),
            absolute(env.TMPDIR),
          ]
        : [
            absolute(env.XDG_STATE_HOME) ??
              (home === undefined ? undefined : join(home, '.local', 'state')),
            absolute(env.XDG_RUNTIME_DIR),
          ];
  return folders
    .filter((folder) => folder !== undefined)
    .map((folder) => join(folder, 'agentrail'));
}

interface Stored {
  readonly id: string;
  readonly seen: number;
}

function parse(text: string): Stored | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    // Edited by hand: a session no run can go on with.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('seen' in value) ||
    typeof value.id !== 'string' ||
    typeof value.seen !== 'number'
  )
    return null;
  return { id: value.id, seen: value.seen };
}

/**
 * The session kept in `file`: null for a file that holds none, `absent`
 * where there is no file, `unusable` for a folder this process cannot read.
 */
function readSession(
  file: string,
  report: (error: Error) => void,
): Stored | null | 'absent' | 'unusable' {
  try {
    return parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const code = codeOf(error);
    if (code === 'ENOENT') return 'absent';
    if (code === undefined || !UNWRITABLE.has(code))
      report(
        new LocalSessionError(`Could not read ${file}.`, { cause: error }),
      );
    return 'unusable';
  }
}

/** The session `stored` still is at `now`: idle less than 30 minutes, and less than a day old. */
function current(
  stored: Stored | null | 'absent' | 'unusable',
  now: number,
): string | null {
  if (typeof stored !== 'object' || stored === null) return null;
  const start = sessionStartOf(stored.id);
  // A clock set back a little keeps the session; a file from the future does not.
  if (start === null || stored.seen - now > REFRESH_MS) return null;
  if (now - stored.seen > IDLE_MS || now - start > MAX_LENGTH_MS) return null;
  return stored.id;
}

/** The file one scope's session is kept in: a person's and each agent's scope are kept apart. */
export function sessionFileName(scope: string): string {
  return `cli-session-${createHash('sha256').update(scope).digest('hex').slice(0, 16)}.json`;
}

/**
 * The local session a CLI keeps when nothing outside it names one: no agent
 * session, no CI run. Kept in one small file per scope, written whole or
 * not at all, so two runs at once never leave a torn one.
 */
export class LocalSession {
  private written: number;

  private constructor(
    readonly id: string,
    private readonly file: string,
    now: number,
    private readonly report: (error: Error) => void,
  ) {
    this.written = now;
  }

  /**
   * The session to go on with or a new one, kept in the first folder this
   * process can write; null when it can write none (a sandbox, a read-only
   * container), and the session lasts only as long as this run.
   */
  static open(
    folders: readonly string[],
    scope: string,
    now: number,
    report: (error: Error) => void,
  ): LocalSession | null {
    for (const folder of folders) {
      const file = join(folder, sessionFileName(scope));
      const stored = readSession(file, report);
      if (stored === 'unusable') continue;
      const kept = current(stored, now);
      if (kept !== null) {
        if (write(file, kept, now, report, 'replace') === 'written')
          return new LocalSession(kept, file, now, report);
        continue;
      }
      const minted = newSessionId(now);
      const result = write(
        file,
        minted,
        now,
        report,
        stored === 'absent' ? 'create' : 'replace',
      );
      if (result === 'failed') continue;
      // Runs started at one moment each found no session: all go on with
      // the one the folder kept, so they are one session, not several.
      const id = current(readSession(file, report), now) ?? minted;
      return new LocalSession(id, file, now, report);
    }
    return null;
  }

  /** Writes that the session was in use at `now`, at most once a minute, and not past its day. */
  touch(now: number): void {
    if (now - this.written < REFRESH_MS) return;
    // A day on, the session is over: a run started now begins its own, and
    // this one must not write the old one back over it.
    if (current({ id: this.id, seen: now }, now) === null) return;
    if (write(this.file, this.id, now, this.report, 'replace') === 'written')
      this.written = now;
  }
}

/** A file system with no hard links (FAT, some network shares): a session is renamed in instead. */
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);

/**
 * Writes the session whole, to a file of this process's own first. Then
 * `create` links it in only where no session file is (`taken` when another
 * run made one first); `replace` renames it over the last.
 */
function write(
  file: string,
  id: string,
  now: number,
  report: (error: Error) => void,
  how: 'create' | 'replace',
): 'written' | 'taken' | 'failed' {
  const partial = `${file}.${process.pid}.tmp`;
  let result: 'written' | 'taken' | 'failed' = 'failed';
  let partialWritten = false;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(partial, JSON.stringify({ id, seen: now }), { mode: 0o600 });
    partialWritten = true;
    if (how === 'create') {
      try {
        linkSync(partial, file);
        result = 'written';
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EEXIST') result = 'taken';
        else if (code === undefined || !NO_LINKS.has(code)) throw error;
      }
    }
    if (result === 'failed') {
      renameSync(partial, file);
      result = 'written';
    }
  } catch (error) {
    const code = codeOf(error);
    if (code === undefined || !UNWRITABLE.has(code))
      report(
        new LocalSessionError(`Could not keep the session in ${file}.`, {
          cause: error,
        }),
      );
  }
  // Linked, refused or not renamed: the partial file would be left behind.
  if (partialWritten) rmSync(partial, { force: true });
  return result;
}
