# agentrail-browser

The Agentrail script, on a site's pages: the steps a person or an agent
driving a browser takes, sent to the Agentrail collector with the browser
source's public key. The proofs come first and need no consent: the session
the edge set, a trace on every call to the site's own origins, the markers a
page was reached by, and the page's WebMCP tool calls. Raw behaviour (timing
only) and the tab's fingerprint are loaded apart, and each can be turned off.

Nothing is read of what is typed, pasted or chosen, nor of the page itself.

> Pre-release: not on npm yet.

## The tag

Agentrail's setup page gives the tag, with the source's public key:

```html
<script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
```

- `data-first-party`: other origins whose calls carry the page's trace,
  comma-separated, as `https://api.example.com`.
- `data-behaviour="off"`, `data-fingerprint="off"`: turn either off.
- `data-collector`: the collector, when it is not where the script came from.

The script is `dist/agentrail.js` in this package, one file.

## From code

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

## Licence

[Apache-2.0](LICENSE).
