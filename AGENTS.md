# agentrail-js agent map

The Agentrail SDKs for JavaScript, published to npm as `agentrail-core`,
`agentrail-edge` and `agentrail-browser` (`packages/*`). They send events to
the Agentrail collector, whose linking engine is private to Argus (the
private `agentrail-co/argus` repository). What the collector takes is
`packages/contract/sdk-contract.json`, copied from Argus.

## Commands

- `pnpm build` first (the edge and the browser read core's built types),
  then `pnpm lint`, `pnpm typecheck`, `pnpm test`.
- One package: `pnpm --filter agentrail-edge test`.

## Rules no machine can check

- Understand the existing code before editing; follow the approved plan and
  ask before changing its scope.
- One pull request per piece of work. Bring `main` in with
  `git merge --no-ff`. Never rebase, amend a pushed commit, or force-push.
  Merge a pull request with a merge commit, never squashed: the packages'
  history from Argus is kept commit by commit.
- A test must earn its place: finish "this test fails if someone …" with a
  realistic change, and watch it fail by making that change.
- Never hide a failure: no swallowed error, no default for a value that must
  exist. What ships never breaks a customer's site: a failure to send is
  told to `onError`, never to the visitor.
- This repository is public. Never commit a secret, a key, or anything from
  a real account or a customer's site.
- `packages/contract/sdk-contract.json` is Argus's: never edit it here. A
  change the collector must take starts in Argus, and its new contract is
  copied here (`packages/contract/README.md`).
- The three packages share one version, bumped together in each
  `package.json` and `packages/core/src/version.ts`; a `v<version>` tag
  publishes them.

Lint stops a `node:` import in what ships (`packages/{core,edge,browser}/src`).
