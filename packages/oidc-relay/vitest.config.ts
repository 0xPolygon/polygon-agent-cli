import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Per-test storage isolation fails on this worker's Durable Object; tests use unique session ids.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' }
      }
    },
    coverage: {
      provider: 'istanbul',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: { lines: 94.6, statements: 91.2, functions: 91.1, branches: 89.8 }
    }
  }
});
