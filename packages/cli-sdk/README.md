# agentrail-cli-sdk

[![npm](https://img.shields.io/npm/v/agentrail-cli-sdk)](https://www.npmjs.com/package/agentrail-cli-sdk)
[![Node](https://img.shields.io/node/v/agentrail-cli-sdk)](https://www.npmjs.com/package/agentrail-cli-sdk)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

Agentrail for your CLI. When an agent such as Claude Code or Codex runs your
CLI, the CLI's calls to your API look like any other client's. This package
puts one header on those calls saying which command ran, in which run, in
which of the agent's sessions and under which agent. The Agentrail server SDK
or edge in front of your API reads it, so [Agentrail](https://www.agentrail.co)
can join the agent's CLI calls into the rest of its journey: the docs it read,
the sign-up it finished, the API calls it made.

Your API reads the header with a server SDK or the edge: `agentrail-node`
and `agentrail-edge` 0.4.0, `agentrail-go` 0.4.0, or `agentrail-python` 0.3.0
and later. On an older one, the header reaches your API and changes nothing.

Nothing is sent anywhere but your own API, and only to the origins you list.
The header never carries what people type: no arguments, flag values, paths,
environment values or the agent's own session id. It depends only on
`agentrail-core`, makes no network call of its own, and writes at most one
small file.

## Install

Node 22 or later. It is an ES module; from CommonJS, `require` it on Node
22.12 or later.

```sh
npm install agentrail-cli-sdk
```

## Quick start

Call `instrumentCli` first thing, before your CLI parses its arguments or
makes a request. Then hand it your framework.

**commander**

```ts
import { Command } from 'commander';
import { instrumentCli } from 'agentrail-cli-sdk';

const agentrail = instrumentCli({
  name: 'acme',
  version: pkg.version,
  origins: ['https://api.acme.com'], // your API, exactly
});

const program = agentrail.commander(new Command('acme'));
// … your commands …
await program.parseAsync();
```

**yargs** (17 and 18)

```ts
await yargs(hideBin(process.argv))
  .middleware(agentrail.yargs)
  .command(/* … */)
  .parseAsync();
```

**oclif**: export the hook, and name it in `package.json` under
`oclif.hooks.prerun`.

```ts
// src/hooks/agentrail.ts
import { agentrail } from '../agentrail.js';

export default agentrail.oclif;
```

**Any other framework**: name the command when it starts.

```ts
agentrail.command('deploy create');
```

Requests made with `fetch`, undici, `http`/`https`, or a client built on them
(axios, got, node-fetch and most generated SDKs) get the header on their own.
It goes only to the origins you list, checked for each request as it is made:
when your API redirects elsewhere (a download link to a storage host, say),
the header comes off.

In Bun or Deno, which publish no request events, put it on yourself, and
follow redirects yourself where your API may send the CLI elsewhere, since
nothing there can take the header off:

```ts
const agentrail = instrumentCli({ /* … */ watchRequests: false });
await fetch(url, {
  headers: { ...agentrail.headers(url), ...yourHeaders },
  redirect: 'manual',
});
```

## What the header says

```http
x-agentrail-cli: v=1, sdk="0.3.0", cli="acme", cliv="2.3.1",
  run="0193f2c4-…", seq=3, ses="5f2c09d1…", sesfrom=agent, mode=agent,
  agent="claude-code", agentv="2.1.325", ev=("AI_AGENT" "CLAUDECODE"),
  cmd="deploy create"
```

| Member            | What it is                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `cli`, `cliv`     | Your CLI's name and version, from your options                                                  |
| `run`, `seq`      | This run of the CLI, and the request's place in it                                              |
| `ses`, `sesfrom`  | The session, as a one-way hash, and where it came from (below)                                  |
| `mode`            | `agent`, `ci`, `interactive` (a terminal) or `non-interactive` (a script)                       |
| `agent`, `agentv` | The agent running the CLI, when one is detected                                                 |
| `ev`              | The names of the environment variables that said so, never their values                         |
| `cmd`             | The command, by the names your code declared: `deploy create`, also when someone typed an alias |

It is an [RFC 9651](https://www.rfc-editor.org/rfc/rfc9651) Dictionary.
A later version only adds members.

## The session

One agent session is one journey, however many times the agent runs your
CLI. The session comes from, in order:

1. **The agent's own session**, where it gives one to the commands it runs:
   Claude Code, Codex, Copilot CLI, OpenCode and Goose do.
2. **The CI run**: GitHub Actions, GitLab, CircleCI, Buildkite, Azure
   Pipelines, Bitbucket, Jenkins, CodeBuild and Travis.
3. **A local session** that ends after 30 minutes without a request and
   lasts a day at most, kept apart for a person and for each agent that
   gives no session of its own (Gemini CLI, Cursor). It is kept in the
   user's state folder (`~/.local/state/agentrail`,
   `~/Library/Application Support/agentrail` or `%LOCALAPPDATA%\agentrail`),
   or the user's own temporary folder when that cannot be written. Two
   windows of one agent without session ids share it.
4. **The run alone**, when no file can be written: in a sandbox, say.

The value sent is a SHA-256 hash of the source and your `sessionScope` (your
CLI's name by default). So the agent's session id never leaves the machine,
and two companies' CLIs in one agent session send values that cannot be
matched. Give your other tools the same `sessionScope` (a second CLI or a
local MCP server) and they share one session.

## Agents, CI and people

`agentrail.mode` and `agentrail.agent` say who is running the CLI. They are
known even when tracking is off, so use them to answer an agent as it reads
best:

```ts
if (agentrail.mode === 'agent') output.json = true;
```

Agents are detected from the variables they set: `AI_AGENT` first, then
each agent's own, as in gh and `@vercel/detect-agent`. A bare `CI=1` is not
read as CI, since some agents set it in their shells.

## Turning it off

- `DO_NOT_TRACK=1` turns everything off.
- `enabled: false` turns it off from your CLI's own telemetry setting.
- `AGENTRAIL_CLI_DEBUG=1` prints each header, and each request left
  without one, to stderr.

## Options

| Option          | Default         | What it does                                              |
| --------------- | --------------- | --------------------------------------------------------- |
| `name`          | (required)      | Your CLI's name, as people type it                        |
| `version`       |                 | Your CLI's version                                        |
| `origins`       | (required)      | The exact origins of your API, as `https://api.acme.com`  |
| `enabled`       | `true`          | `false` turns everything off                              |
| `sessionScope`  | `name`          | Tools of yours that share sessions give the same scope    |
| `watchRequests` | `true`          | `false` leaves requests alone: use `headers(url)` instead |
| `onError`       | `console.error` | Told what could not be recorded; your command goes on     |
| `env`           | `process.env`   | The environment to read                                   |

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
