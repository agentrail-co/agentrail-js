import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/index.js';

const PACKAGES = ['core', 'edge', 'browser', 'node'];

describe('the version', () => {
  // Fails if someone bumps one package's version without the others or
  // VERSION: a component would report a version that was never published,
  // or a release would publish packages that do not match.
  it('is every package’s, as its manifest names it', () => {
    for (const name of PACKAGES) {
      const manifest = JSON.parse(
        readFileSync(
          new URL(`../../${name}/package.json`, import.meta.url),
          'utf8',
        ),
      ) as { name: string; version: string };
      expect([manifest.name, manifest.version]).toEqual([
        `agentrail-${name}`,
        VERSION,
      ]);
    }
  });
});
