# Agentrail CLI SDK

What a customer's CLI puts on its requests to its own API: the
`x-agentrail-cli` header (`agentrail-core`'s `formatCliHeader`), naming
the command, the run, the session and the agent. A server SDK or the edge
reads it with `readCliHeader`. It runs in Node only, inside other people's
CLIs, on every start. How a CLI uses it: [README.md](README.md).

## Rules no machine can check

- The header goes only to an origin the CLI listed, checked for each
  request as it is made, so a redirect elsewhere carries none: one the CLI
  put on itself (`headers(url)`) comes off where no SDK in the process
  lists the origin, as `fetch` keeps a request's headers across redirects.
- Never what people type: the command comes from the names the CLI's code
  declared (commander's names, yargs' declared commands, oclif's id), never
  from argv. Arguments, flag values, paths, environment values and the
  agent's own session id never leave the process; the session leaves it
  only as `sessionKey`'s hash. A person's local session and each agent's
  are kept apart.
- `DO_NOT_TRACK` and `enabled: false` turn off everything, and the CLI's
  requests go out untouched.
- The CLI never breaks: a request hook that throws ends the process, so
  every hook reports to `onError` and lets the request go out as it was. A
  folder the CLI cannot write is normal (a sandbox, a read-only container):
  the next is tried, and only an error no folder explains goes to `onError`.
- Nothing slows a start: no network call of its own, no file read or
  written before the first request, and no dependency but `agentrail-core`
  (`test/package.test.ts`).
- The session's derivation, the header and the detection tables are the
  same in the Go and Python CLI SDKs and the stdio MCP adapters: change
  them together.

Tests: `pnpm --filter agentrail-cli-sdk test`. They run real commander,
yargs (17 and 18) and oclif programs against an API on this machine.
