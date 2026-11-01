# agentrail-core

What every Agentrail component shares, wherever the Fetch API and WebCrypto
run (Cloudflare Workers, Vercel's edge, Node, browsers): the event the
collector takes, as types; markers; the keyed hash a workspace hashes
addresses and principals with, and its key's id; W3C trace context; and the
collector client, which batches events, retries what the network or the
collector failed, and tells `onError` of every call given up.

`agentrail-edge` and `agentrail-browser` are built on it; a component of
your own can be too.

> Pre-release: not on npm yet.

## Licence

[Apache-2.0](LICENSE).
