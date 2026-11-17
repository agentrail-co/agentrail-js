import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ConfigurationError, instrumentCli } from '../src/index.js';

const source = new URL('../src/', import.meta.url);

describe('the package', () => {
  // Fails if someone adds a dependency, or imports one that is only
  // installed here: every CLI that installs the SDK would carry it, and a
  // CLI's install size and start time are its users' first impression.
  it('depends on agentrail-core and Node alone', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ 'agentrail-core': 'workspace:*' });
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    const imported = readdirSync(source)
      .filter((file) => file.endsWith('.ts'))
      .flatMap((file) =>
        [
          ...readFileSync(new URL(file, source), 'utf8').matchAll(
            /^(?:import|export)\b[^'"]*from '([^']+)'/gmu,
          ),
        ].map((match) => match[1]),
      );
    expect(imported.length).toBeGreaterThan(0);
    for (const specifier of imported)
      expect(specifier).toMatch(/^(?:\.\/|node:|agentrail-core$)/u);
  });

  // Fails if someone lets an origin with a path or a wildcard through: the
  // header would go to whatever the CLI's author thought it matched.
  it('refuses options it cannot run with, the first time the CLI runs', () => {
    const env = {};
    for (const options of [
      { name: 'acme', origins: [] },
      { name: 'acme', origins: ['https://api.acme.com/v1'] },
      { name: 'acme', origins: ['https://*.acme.com'] },
      { name: 'acme', origins: ['api.acme.com'] },
      { name: 'acme', origins: ['ftp://api.acme.com'] },
      { name: ' acme', origins: ['https://api.acme.com'] },
      { name: 'acme', version: 'ünicode', origins: ['https://api.acme.com'] },
    ])
      expect(() => instrumentCli({ ...options, env })).toThrow(
        ConfigurationError,
      );
  });
});
