# agentrail-core

What every Agentrail component shares, wherever the Fetch API and WebCrypto
run (Cloudflare Workers, Vercel's edge, Node, browsers): the event the
collector takes, as types; markers, minted and read (`parseMarker`) as the
collector's engine reads them; the keyed hash a workspace hashes addresses
and principals with, and its key's id; W3C trace context; the session
cookie, which ends after 30 minutes idle and a day at most, its id a UUIDv7
that carries its start; and the collector client, which batches events,
retries what the network or the collector failed, and tells `onError` of
every call given up.

`agentrail-edge` and `agentrail-browser` are built on it; a component of
your own can be too.

> Pre-release: not on npm yet.

## Licence

[Apache-2.0](LICENSE).
