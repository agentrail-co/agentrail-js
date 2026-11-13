# agentrail-browser

[![npm](https://img.shields.io/npm/v/agentrail-browser)](https://www.npmjs.com/package/agentrail-browser)
[![License](https://img.shields.io/github/license/agentrail-co/agentrail-js)](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE)

The Agentrail script for your pages. It records page views, the trace on your
pages' calls to your own services, the markers a page was reached by, and
WebMCP tool calls: which tool ran, whether it answered, threw or returned an
error, and the size of its arguments and result. Nothing is read of what is
typed, pasted or chosen, nor of the page itself. Behaviour and the fingerprint
are off unless you turn them on, and so are WebMCP payloads.

## The hosted tag

Most sites don't install this package. In Agentrail, open **Journeys → Set up**
and choose **Browser**, then add the tag it gives you to every page:

```html
<script async src="https://<collector>/agentrail.js" data-key="ajp_…"></script>
```

## Bundle it yourself

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

Call `start` once a page, as early as it can load.

### WebMCP payloads

A tool's arguments and result are not sent unless you turn on
`capturePayloads`, which only this API can do (a tag attribute cannot carry a
function). Each run goes to your `redact` hook first; what it returns is sent
as JSON text to the collector's `POST /ingest/browser/payloads`, and `null`
sends the run without content:

```js
start({
  key: 'ajp_…',
  collector: 'https://<collector>/ingest/browser',
  capturePayloads: {
    redact: ({ tool, arguments: args, result }) =>
      tool === 'search' ? { arguments: args, result } : null,
  },
});
```

A run whose payload call fails is still sent, without its payload. A closing
page sends a payload still on its way as a beacon, cut to fit 30,000 bytes and
flagged as truncated.

## Documentation

| Topic                                                    | Guide                                                                                                                |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tag attributes, your own services, the session, bundling | [Install the browser script](https://www.agentrail.co/docs/guides/journeys-browser)                                  |
| Behaviour, the fingerprint and consent                   | [Behaviour and the fingerprint](https://www.agentrail.co/docs/guides/journeys-browser#behaviour-and-the-fingerprint) |
| What the script sends                                    | [What Agentrail records](https://www.agentrail.co/docs/guides/journeys-data)                                         |

Before 1.0, a minor version (0.1 to 0.2) may change what the package offers.

## Licence

[Apache-2.0](https://github.com/agentrail-co/agentrail-js/blob/main/LICENSE).
