import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod/v4';

// Lazy so tests can import modules that read env without every variable set.
function buildEnv() {
  return createEnv({
    clientPrefix: 'VITE_',
    client: {
      VITE_TRAILS_API_KEY: z.string().optional(),
      VITE_INDEXER_ACCESS_KEY: z.string().optional(),
      VITE_POLYGON_INDEXER_ACCESS_KEY: z.string().optional(),
      VITE_PROJECT_ACCESS_KEY: z.string().optional(),
      VITE_INDEXER_URL: z.url().optional(),
      VITE_OIDC_RELAY_URL: z.url().default('https://oidc-relay.polygon.technology')
    },
    runtimeEnv: import.meta.env,
    // CI passes unset variables as empty strings; treat them as missing.
    emptyStringAsUndefined: true
  });
}

let cached: ReturnType<typeof buildEnv> | undefined;

export function getEnv(): ReturnType<typeof buildEnv> {
  cached ??= buildEnv();
  return cached;
}

/** Tests only: clears the memoised value so the next getEnv() re-reads import.meta.env. */
export function resetEnv(): void {
  cached = undefined;
}
