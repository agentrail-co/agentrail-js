import { describe, expect, it } from 'vitest';

import { BrowserTagKeyMissingError, optionsOf } from '../src/tag.js';
import { COLLECTOR, KEY } from './support/page.js';

function tagOf(attributes: Record<string, string>): HTMLScriptElement {
  const tag = document.createElement('script');
  for (const [name, value] of Object.entries(attributes))
    tag.setAttribute(name, value);
  return tag;
}

describe('the script tag', () => {
  // Fails if someone reads the key from anywhere but the tag, sends to
  // another collector than the one the script came from, or starts a part
  // the site turned off.
  it('takes its key, its collector and its parts from its own tag', () => {
    expect(
      optionsOf(
        tagOf({
          src: 'https://collector.example.test/agentrail.js',
          'data-key': KEY,
          'data-first-party':
            'https://api.example.test, https://app.example.test',
          'data-fingerprint': 'off',
        }),
      ),
    ).toEqual({
      key: KEY,
      collector: COLLECTOR,
      firstParty: ['https://api.example.test', 'https://app.example.test'],
      behaviour: true,
      fingerprint: false,
    });
    expect(() =>
      optionsOf(tagOf({ src: 'https://collector.example.test/agentrail.js' })),
    ).toThrow(BrowserTagKeyMissingError);
  });
});
