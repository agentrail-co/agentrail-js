import { defineConfig } from 'vitest/config';

// A page's DOM for every test.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    environment: 'jsdom',
  },
});
