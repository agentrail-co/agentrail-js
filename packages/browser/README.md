# agentrail-browser

The Agentrail script, on a site's pages: the steps a person or an agent
driving a browser takes, sent to the Agentrail collector with the browser
source's public key. The proofs come first and need no consent: the session
the edge set, a trace on every call to the site's own origins, the markers a
page was reached by, and the page's WebMCP tool calls. Raw behaviour (timing
only) and the tab's fingerprint are loaded apart, and each is off unless the
site turns it on.

Nothing is read of what is typed, pasted or chosen, nor of the page itself.

Full guide: [Add the browser script](https://www.agentrail.co/docs/guides/journeys-browser).

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## The tag

Agentrail's setup page gives the tag, with the source's public key:

```html
<script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
```

- `data-first-party`: other origins whose calls carry the page's trace,
  comma-separated, as `https://api.example.com`.
- `data-behaviour="on"`: record raw behaviour, timing only.
- `data-fingerprint="on"`: read the tab's fingerprint, once a tab. Only for
  a visitor who has consented (see Consent).
- `data-session-idle`: seconds without a request after which a visitor's
  session ends; 1800 (30 minutes) by default.
- `data-session-domain`: the domain a session is shared across, as
  `example.com`; by default, the page's host.
- `data-collector`: the collector, when it is not where the script came from.

The script is `dist/agentrail.js` in this package, one file.

## From code

For a site that bundles the script itself:

```sh
npm install agentrail-browser
```

```js
import { start } from 'agentrail-browser';

start({
  key: 'ajp_…',
  collector: 'https://<collector>/ingest/browser',
  firstParty: ['https://api.example.com'],
});
```

Once a page, as early as it can load. `onError` is told of every call the
collector refused or never got; the page's console is warned otherwise.
`behaviour: true` and `fingerprint: true` turn those parts on, and
`sessionIdleTimeout` and `sessionCookieDomain` are the two session
attributes above.

## Consent

The proofs need no consent. The fingerprint identifies a visitor's browser,
so turn it on only for a visitor who has consented: render
`data-fingerprint="on"`, or pass `fingerprint: true`, once the site's
consent banner or cookie says yes. A visitor who consents part-way through
a page is fingerprinted from their next page load.

The script runs on plain HTTP too, and in browsers from before 2023.

## The session

The session is the cookie the edge sets (`agentrail_session`); on a site
with no edge, the script sets it the same way. It ends after 30 minutes
without a request, and a day after it began: every page view, a
single-page app's routes too, writes it again for another 30 minutes. On a
site with the edge, give both the same idle timeout and domain.

## Licence

[Apache-2.0](LICENSE).
