# Agentrail SDKs for JavaScript

What a site runs so Agentrail can follow the journeys agents and people take
through it: each step recorded where it happens, and sent to the Agentrail
collector, which links the steps into journeys.

| Package                                 | What it is                                                                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`agentrail-edge`](packages/edge)       | In front of a site on Cloudflare Workers, Vercel or any Fetch API runtime: records each request, and marks the links in answers meant for agents. |
| [`agentrail-browser`](packages/browser) | The script on a site's pages: page views, the trace on the page's own calls, and WebMCP tool calls.                                               |
| [`agentrail-core`](packages/core)       | What both share: the event the collector takes, markers, the keyed hash, W3C trace context, the session, and the client that sends events.        |

**Pre-release.** Not on npm yet. The first versions will be published under
npm's `next` tag.

## Development

```sh
pnpm install
pnpm build      # first: the edge and the browser read core's built types
pnpm lint
pnpm typecheck
pnpm test
```

The three packages share one version and are released together: a
`v<version>` tag publishes all three (`.github/workflows/release.yml`).

## Licence

[Apache-2.0](LICENSE).
