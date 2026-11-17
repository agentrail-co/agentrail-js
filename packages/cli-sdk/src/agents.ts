/**
 * Which agent, if any, is running the CLI, from the environment the agent
 * gives the commands it runs. The table follows gh's (cli/cli
 * `internal/agents/detect.go`) and `@vercel/detect-agent`, and adds the
 * variable each agent names its own session in. Detection is a claim:
 * the header carries the names of the variables it was told by, so the
 * collector can name the agent again as agents change what they set.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export interface Agent {
  /** As `claude-code` or `codex`: lowercase letters, digits, `.`, `_` and `-`. */
  readonly id: string;
  readonly version?: string | undefined;
  /** The variables it was told by, in the order they were read. */
  readonly evidence: readonly string[];
  /** The variable the agent names its own session in, and its value, when it gives one. */
  readonly session?:
    { readonly name: string; readonly value: string } | undefined;
}

interface Rule {
  readonly id: string;
  /** Variables any one of which, set, names the agent. */
  readonly set?: readonly string[];
  /** Variables that name the agent when they hold this value. */
  readonly equal?: readonly (readonly [name: string, value: string])[];
  /** Where the agent puts its own session id for the commands it runs, the first set taken. */
  readonly sessions?: readonly string[];
}

/**
 * Checked in order; the first that matches names the agent. Amp sets
 * `CLAUDECODE` and Cowork is a Claude Code mode, so both come before Claude
 * Code. Signals present outside an agent are left out, as they would name a
 * person at a terminal as an agent: `REPL_ID` (any Replit shell),
 * `GOOSE_PROVIDER` (wherever Goose is configured), `CURSOR_TRACE_ID` and
 * `TERM_PROGRAM=kiro` (every terminal in those editors), a bare `AGENT`
 * (`AGENT=1` names no one) and a bare `CI`.
 */
const RULES: readonly Rule[] = [
  { id: 'amp', equal: [['AGENT', 'amp']] },
  {
    id: 'codex',
    set: ['CODEX_SANDBOX', 'CODEX_CI', 'CODEX_THREAD_ID'],
    sessions: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID'],
  },
  { id: 'gemini-cli', set: ['GEMINI_CLI'] },
  {
    id: 'copilot-cli',
    set: ['COPILOT_CLI'],
    sessions: ['COPILOT_AGENT_SESSION_ID'],
  },
  { id: 'opencode', set: ['OPENCODE'], sessions: ['OPENCODE_SESSION_ID'] },
  { id: 'antigravity', set: ['ANTIGRAVITY_AGENT'] },
  { id: 'augment-cli', set: ['AUGMENT_AGENT'] },
  {
    id: 'cowork',
    set: ['CLAUDE_CODE_IS_COWORK'],
    sessions: ['CLAUDE_CODE_SESSION_ID'],
  },
  {
    id: 'claude-code',
    set: ['CLAUDECODE', 'CLAUDE_CODE'],
    sessions: ['CLAUDE_CODE_SESSION_ID'],
  },
  {
    id: 'cursor-cli',
    set: ['CURSOR_AGENT'],
    equal: [['CURSOR_EXTENSION_HOST_ROLE', 'agent-exec']],
  },
  {
    id: 'goose',
    set: ['GOOSE_TERMINAL'],
    equal: [['AGENT', 'goose']],
    sessions: ['AGENT_SESSION_ID'],
  },
  { id: 'cline', equal: [['CLINE_ACTIVE', 'true']] },
];

const MAX_ID = 64;
/** Claude Code's `AI_AGENT`: `claude-code_2-1-325_agent`. */
const VERSIONED = /^(.+?)_(\d+(?:-\d+)*)_agent$/u;
const SUFFIXED = /^(.+)_agent$/u;

function valueOf(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/** The variables of `rule` that are set as it reads them, in its order. */
function evidenceOf(env: Environment, rule: Rule): string[] {
  const names = (rule.set ?? []).filter(
    (name) => valueOf(env, name) !== undefined,
  );
  for (const [name, value] of rule.equal ?? [])
    if (valueOf(env, name) === value && !names.includes(name)) names.push(name);
  return names;
}

function sessionOf(env: Environment, rule: Rule | undefined): Agent['session'] {
  for (const name of rule?.sessions ?? []) {
    const value = valueOf(env, name);
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

/** An agent's own name for itself, as an id the header can carry. */
function idOf(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_ID);
  return id === '' ? 'unknown' : id;
}

/**
 * The agent `AI_AGENT` names, the variable agents are settling on. Claude Code writes
 * `claude-code_2-1-325_agent`, VS Code's Copilot `github_copilot_vscode_agent`,
 * OpenCode `opencode`: the name, then the version and `_agent` when given.
 */
function declared(env: Environment, variable: string): Agent | null {
  const value = valueOf(env, variable);
  if (value === undefined) return null;
  const versioned = VERSIONED.exec(value);
  const name = versioned?.[1] ?? SUFFIXED.exec(value)?.[1] ?? value;
  const id = idOf(name);
  const rule = RULES.find((candidate) => candidate.id === id);
  const evidence = [variable];
  if (rule !== undefined)
    for (const name of evidenceOf(env, rule))
      if (!evidence.includes(name)) evidence.push(name);
  return {
    id,
    version: versioned?.[2]?.replaceAll('-', '.'),
    evidence,
    session: sessionOf(env, rule),
  };
}

/** The agent running this process, or null when nothing says one is. */
export function detectAgent(env: Environment): Agent | null {
  const named = declared(env, 'AI_AGENT');
  if (named !== null) return named;
  for (const rule of RULES) {
    const evidence = evidenceOf(env, rule);
    if (evidence.length > 0)
      return { id: rule.id, evidence, session: sessionOf(env, rule) };
  }
  return null;
}
