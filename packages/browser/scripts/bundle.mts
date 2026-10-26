import { build } from 'esbuild';

/**
 * `dist/agentrail.js`: the script tag's one file, every part loaded apart
 * inlined, for any browser a customer's visitors use. The collector serves
 * it.
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
});
