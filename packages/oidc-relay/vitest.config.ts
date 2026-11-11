import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Per-test storage isolation fails on this worker's Durable Object; tests use unique session ids.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' }
      }
    }
  }
});
