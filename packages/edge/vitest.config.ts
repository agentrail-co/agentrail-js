import { defineConfig } from 'vitest/config';

// Reporters and their output location only, as every package pins them.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/agentrail-edge.xml' },
  },
});
