# Agentrail SDKs for JavaScript

What a site runs so Agentrail can follow the journeys agents and people take
through it: each step recorded where it happens, and sent to the Agentrail
collector, which links the steps into journeys.

| Package                                 | What it is                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agentrail-edge`](packages/edge)       | In front of a site on Cloudflare Workers, Vercel or any Fetch API runtime: records each request, and marks the links in answers meant for agents. |
| [`agentrail-browser`](packages/browser) | The script on a site's pages: page views, the trace on the page's own calls, and WebMCP tool calls.                                               |
| [`agentrail-node`](packages/node)       | Node backend HTTP/fetch traces, structured logs, verified application identity and MCP calls.                                                     |
| [`agentrail-core`](packages/core)       | What both share: the event the collector takes, markers, the keyed hash, W3C trace context, the session, and the client that sends events.        |

```sh
npm install agentrail-edge      # in front of the site
npm install agentrail-node      # in the Node backend
npm install agentrail-browser   # only for a site that bundles the script itself
```

Before 1.0, a minor version (0.1 to 0.2) may change what the packages offer.

## Development

```sh
pnpm install
pnpm build      # first: the edge and the browser read core's built types
pnpm lint
pnpm typecheck
pnpm test
```

## Releasing

The four packages share one version and are released together: a
`v<version>` tag publishes all four (`.github/workflows/release.yml`). A
version such as `0.2.0` goes to npm's `latest` tag, and a trial build such as
`0.2.0-dev.1` to `next`.

Only the repository's admins can push a `v*` tag, and the run then waits for
approval in the `npm` environment. npm trusts the workflow, so no token is
stored: each package's trusted publisher names `agentrail-co`,
`agentrail-js`, `release.yml` and the `npm` environment, and allows
`npm publish`. A run that published some packages and then failed can be
run again once the cause is fixed: it skips a version npm already has.

## Licence

[Apache-2.0](LICENSE).
