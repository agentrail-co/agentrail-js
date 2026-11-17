import { describe, expect, it } from 'vitest';

import { detectAgent } from '../src/agents.js';
import { detectCi } from '../src/ci.js';

describe('the agent', () => {
  // Fails if someone sends AI_AGENT's value as it is: Claude Code's
  // `claude-code_2-1-325_agent` would be a new agent with every release,
  // and the run's session would be lost with the session variable.
  it('is Claude Code, from what Claude Code 2.1.325 gives the commands it runs', () => {
    expect(
      detectAgent({
        AI_AGENT: 'claude-code_2-1-325_agent',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 'session-from-claude',
      }),
    ).toEqual({
      id: 'claude-code',
      version: '2.1.325',
      evidence: ['AI_AGENT', 'CLAUDECODE'],
      session: { name: 'CLAUDE_CODE_SESSION_ID', value: 'session-from-claude' },
    });
  });

  // Fails if someone checks CLAUDECODE before Amp's or Codex's own
  // variables: Amp sets CLAUDECODE too, and Codex's thread is its session.
  it.each([
    [{ AGENT: 'amp', CLAUDECODE: '1' }, 'amp', undefined],
    [
      {
        CODEX_SANDBOX: 'seatbelt',
        CODEX_THREAD_ID: 'thread-1',
        CLAUDECODE: '1',
      },
      'codex',
      'CODEX_THREAD_ID',
    ],
    [
      { COPILOT_CLI: '1', COPILOT_AGENT_SESSION_ID: 'c-1' },
      'copilot-cli',
      'COPILOT_AGENT_SESSION_ID',
    ],
    [{ AGENT: 'goose', AGENT_SESSION_ID: 'g-1' }, 'goose', 'AGENT_SESSION_ID'],
    [{ GEMINI_CLI: '1' }, 'gemini-cli', undefined],
    [
      { AI_AGENT: 'github_copilot_vscode_agent' },
      'github-copilot-vscode',
      undefined,
    ],
  ])('is named from %o as %s', (env, id, session) => {
    const agent = detectAgent(env);
    expect([agent?.id, agent?.session?.name]).toEqual([id, session]);
  });

  // Fails if someone takes a signal that is there outside any agent: a
  // person in a Replit, Kiro or Cursor terminal, or one who set CI=1, would
  // read as an agent, and a CLI would answer them in JSON.
  it('is none in a person’s shell', () => {
    expect(
      detectAgent({
        CI: '1',
        REPL_ID: 'repl',
        GOOSE_PROVIDER: 'anthropic',
        TERM_PROGRAM: 'kiro',
        CURSOR_TRACE_ID: 'trace-in-every-cursor-terminal',
        AGENT: '1',
        AI_AGENT: ' ',
      }),
    ).toBeNull();
  });
});

describe('the CI run', () => {
  // Fails if someone drops a part of GitHub's run (its attempt, say): a
  // re-run would join the first run's session.
  it('is one run of one workflow, attempt included', () => {
    const run = {
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'acme/app',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
    };
    expect(detectCi(run)?.run).toBe(
      'github-actions:https://github.com/acme/app/42/1',
    );
    expect(detectCi({ ...run, GITHUB_RUN_ATTEMPT: '2' })?.run).not.toBe(
      detectCi(run)?.run,
    );
    expect(detectCi({ TF_BUILD: 'True' })).toEqual({
      id: 'azure-pipelines',
      evidence: 'TF_BUILD',
      run: undefined,
    });
    expect(detectCi({ CI: 'true' })).toBeNull();
  });
});
