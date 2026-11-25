import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    exclude: ['**/node_modules/**', 'test/prod-smoke/**'],
    poolOptions: {
      workers: {
        // Per-test storage isolation fails on this worker's Durable Object; tests use unique session ids.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' }
      }
    }
  }
});
