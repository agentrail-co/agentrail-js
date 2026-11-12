# Contributing to agentrail-js

The repository holds four published packages (`packages/core`, `edge`,
`browser`, `node`) and a private one, `packages/contract`, which checks the
packages against the collector's contract. Read [AGENTS.md](AGENTS.md) for the
rules a change follows.

## Development

```sh
pnpm install
pnpm build      # first: the edge and the browser read core's built types
pnpm lint       # ESLint and Prettier
pnpm typecheck
pnpm test
```

One package: `pnpm --filter agentrail-edge test`.

## Releasing

The four packages share one version, bumped together in each
`packages/*/package.json` and `packages/core/src/version.ts`, and are released
together: a `v<version>` tag publishes all four
(`.github/workflows/release.yml`). A version such as `0.2.0` goes to npm's
`latest` tag, and a trial build such as `0.2.0-dev.1` to `next`.

Only the repository's admins can push a `v*` tag, and the run then waits for
approval in the `npm` environment. npm trusts the workflow, so no token is
stored: each package's trusted publisher names `agentrail-co`,
`agentrail-js`, `release.yml` and the `npm` environment, and allows
`npm publish`. A run that published some packages and then failed can be run
again once the cause is fixed: it skips a version npm already has.
