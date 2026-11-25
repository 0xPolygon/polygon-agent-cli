import { defineConfig } from 'vitest/config';

// Prod-smoke tier: read-only checks against a deployed instance over HTTPS. The default
// vitest.config.ts excludes test/prod-smoke so a bare `pnpm test` can never reach production.
export default defineConfig({
  test: {
    include: ['test/prod-smoke/**/*.prod-smoke.test.ts'],
    testTimeout: 20_000
  }
});
