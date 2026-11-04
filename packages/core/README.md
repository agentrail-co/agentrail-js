# agentrail-core

What every Agentrail component shares, wherever the Fetch API and WebCrypto
run (Cloudflare Workers, Vercel's edge, Node, browsers): the event the
collector takes, as types; markers, minted and read (`parseMarker`) as the
collector's engine reads them; the keyed hash a workspace hashes addresses
and principals with, and its key's id; W3C trace context; the session
cookie, which ends after 30 minutes idle and a day at most, its id a UUIDv7
that carries its start; and the collector client. Its `send(event,
deadline)` resolves once the call carrying the event has ended: one call is
under way at a time, and what is sent meanwhile goes in the next, together.
It retries what the network or the collector failed after a random wait,
never sooner than a `Retry-After`, ends every call by its deadline, and
tells `onError` of every call given up. And the Web Bot Auth check
(`createSignatureVerifier`): a request's `Signature-Agent`,
`Signature-Input` and `Signature` checked against the keys the named agent
publishes at its `/.well-known/http-message-signatures-directory`, read once
per `max-age` and only from the known signers' hosts (`KNOWN_SIGNERS`) and
the ones a site names, since a caller chooses the URL; Ed25519, RSA-PSS-SHA512 and ECDSA-P256; the outcome is
`verified`, `invalid` (a forged or stale signature, or a key the directory
does not hold), `directory_unreachable` or `unsupported`, so a directory that
is down is never read as a forgery and a signature it does not read is never
called one.

`agentrail-edge` and `agentrail-browser` are built on it; a component of
your own can be too.

```sh
npm install agentrail-core
```

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](LICENSE).
