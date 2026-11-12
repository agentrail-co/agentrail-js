# agentrail-core

[![npm](https://img.shields.io/npm/v/agentrail-core)](https://www.npmjs.com/package/agentrail-core)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

What every Agentrail component shares, wherever the Fetch API and WebCrypto
run: the event the collector takes, markers, the workspace's keyed hash, W3C
trace context, the session cookie, the signed trace handoff, the Web Bot Auth
check and the client that sends events to the collector.

**To record a site, install one of these instead**:
[`agentrail-edge`](https://www.npmjs.com/package/agentrail-edge),
[`agentrail-browser`](https://www.npmjs.com/package/agentrail-browser) or
[`agentrail-node`](https://www.npmjs.com/package/agentrail-node). They are
built on this package. Install it directly only to build a component of your
own:

```sh
npm install agentrail-core
```

Start from the [repository README](https://github.com/agentrail-co/agentrail-js#readme)
and the [Journeys guide](https://www.agentrail.co/docs/guides/journeys).

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
