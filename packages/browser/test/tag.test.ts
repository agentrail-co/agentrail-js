import { SessionTimeoutError } from 'agentrail-core';
import { describe, expect, it, vi } from 'vitest';

import { start } from '../src/index.js';
import { BrowserTagKeyMissingError, optionsOf } from '../src/tag.js';
import { COLLECTOR, KEY, onPage } from './support/page.js';

const SRC = 'https://collector.example.test/agentrail.js';

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

  // Fails if someone drops either attribute on the way from the tag to the
  // cookie (a site's subdomains would split one visitor in two, or its
  // sessions end on another idle timeout than its edge's), or checks the
  // timeout only once the page counts as started (the tag, fixed, could
  // never start).
  it("takes the session's idle timeout and domain from its tag, and starts once a timeout it refused is fixed", () => {
    const tag = {
      src: SRC,
      'data-key': KEY,
      'data-session-domain': 'example.test',
      'data-behaviour': 'off',
      'data-fingerprint': 'off',
    };
    expect(() =>
      start({
        ...optionsOf(tagOf({ ...tag, 'data-session-idle': '30m' })),
        window,
      }),
    ).toThrow(SessionTimeoutError);

    const writes = vi.spyOn(document, 'cookie', 'set');
    try {
      onPage(optionsOf(tagOf({ ...tag, 'data-session-idle': '3600' })));
      expect(writes.mock.calls.map(([written]) => written)).toEqual([
        expect.stringMatching(
          /^agentrail_session=[0-9a-f-]{36}; Path=\/; Max-Age=3600; Domain=example\.test; SameSite=Lax$/u,
        ),
      ]);
    } finally {
      writes.mockRestore();
    }
  });
});
