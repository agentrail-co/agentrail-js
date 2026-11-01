import { readFileSync } from 'node:fs';

import { build } from 'esbuild';

const { name, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

/**
 * `dist/agentrail.js`: the script tag's one file, every part loaded apart
 * inlined, for any browser a customer's visitors use. The collector serves
 * it, and it names its package, version and licence in its first line.
 */
await build({
  entryPoints: [new URL('../src/script.ts', import.meta.url).pathname],
  outfile: new URL('../dist/agentrail.js', import.meta.url).pathname,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  banner: { js: `/*! ${name} ${version} | Apache-2.0 */` },
});
