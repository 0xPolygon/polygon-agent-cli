import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineWorkersProject } from '@cloudflare/vitest-pool-workers/config';
import { defineConfig } from 'vitest/config';

import { outbound } from './worker/test-outbound/index.ts';

const pkgDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    // Istanbul because V8 coverage does not work inside workerd; one provider per run.
    coverage: {
      provider: 'istanbul',
      include: ['worker/**/*.ts', 'src/**/*.{ts,tsx}', 'skills-index.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        'worker/test-*.ts',
        'worker/test-outbound/**',
        'worker/money/test-fakes.ts'
      ],
      reporter: ['text-summary', 'text'],
      // Floors from measured runs (min minus 0.5); raise by hand, never autoUpdate.
      thresholds: {
        statements: 51.2,
        branches: 42.1,
        functions: 42.3,
        lines: 53.2,
        'worker/money/**': { statements: 64.6, branches: 53.2, functions: 64.1, lines: 67.1 }
      }
    },
    projects: [
      {
        resolve: {
          alias: {
            // The Workers runtime module does not exist in Node.
            'cloudflare:workers': path.resolve(pkgDir, 'worker/test-cloudflare-workers.ts')
          }
        },
        test: {
          name: 'node',
          include: ['worker/**/*.test.ts', 'src/**/*.test.ts', 'skills-index.test.ts'],
          exclude: ['**/*.workers.test.ts', '**/node_modules/**'],
          // Bundle the OAuth provider so the alias reaches its import.
          server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } }
        }
      },
      defineWorkersProject({
        test: {
          name: 'workers',
          include: ['worker/**/*.workers.test.ts'],
          poolOptions: {
            workers: {
              // No wrangler config: its bindings live under env blocks, and it would load local secrets.
              main: './worker/index.ts',
              // The outbound fake's log is process-wide, so test files must not overlap.
              singleWorker: true,
              miniflare: {
                compatibilityDate: '2024-07-04',
                durableObjects: { AGENT_KEYS: { className: 'AgentKey', useSQLite: true } },
                kvNamespaces: ['OAUTH_KV'],
                ratelimits: { REGISTER_LIMITER: { simple: { limit: 10, period: 60 } } },
                bindings: {
                  AGENT_CERT_SECRET: randomBytes(32).toString('hex'),
                  CREDENTIALS_KEY: randomBytes(32).toString('hex'),
                  TRAILS_API_KEY: 'test-trails-key',
                  INDEXER_ACCESS_KEY: 'test-indexer-key',
                  OMS_PUBLISHABLE_KEY: 'pk_sdbx_testproject_testkey'
                },
                outboundService: outbound
              }
            }
          }
        }
      })
    ]
  }
});
