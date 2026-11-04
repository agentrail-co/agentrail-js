// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const KEY = 'ajp_public-key-of-the-browser-source';

describe('agentrail.js', () => {
  // Fails if someone bundles another entry than the tag's, splits the file
  // into chunks a classic tag cannot load, or starts it from anything but
  // its own tag: the page would record nothing, or send without its key.
  it('runs as one classic file from its tag, and sends the page with its key', async () => {
    // The file the collector serves, as `build` wrote it.
    const bundled = await readFile(
      join(import.meta.dirname, '../dist/agentrail.js'),
      'utf8',
    );
    const { window } = new JSDOM('<!doctype html><html><head></head></html>', {
      url: 'https://www.customer.example/pricing',
      runScripts: 'dangerously',
    });
    // What every browser has and jsdom lacks.
    window.performance.getEntriesByType = () => [];
    const sent: string[] = [];
    window.fetch = (_url, init) => {
      sent.push(typeof init?.body === 'string' ? init.body : '');
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const tag = window.document.createElement('script');
    tag.dataset.key = KEY;
    tag.dataset.collector = 'https://collector.example.test/ingest/browser';
    tag.dataset.behaviour = 'off';
    tag.dataset.fingerprint = 'off';
    tag.textContent = bundled;
    window.document.head.appendChild(tag);
    window.dispatchEvent(new window.Event('pagehide'));
    const calls = sent.map(
      (body) => JSON.parse(body) as { key: string; events: { kind: string }[] },
    );
    window.close();

    expect(calls.map((call) => call.key)).toEqual([KEY]);
    expect(calls.flatMap((call) => call.events.map((e) => e.kind))).toEqual([
      'page.view',
    ]);
  });
});
