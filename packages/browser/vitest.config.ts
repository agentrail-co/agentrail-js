import { defineConfig } from 'vitest/config';

// A page's DOM for every test; reporters and their output location as every
// package pins them.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'jsdom',
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/agentrail-browser.xml' },
  },
});
