import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

import { CliError } from './errors.ts';

// Only http(s): a bare "localhost:8787" parses as a URL with a made-up scheme, and
// mailto:/file: are never a service endpoint.
const httpUrl = z.url({ protocol: /^https?$/ });

// Lazy so tests can import modules that read env without every variable set.
function buildEnv() {
  return createEnv({
    server: {
      // State folder. A workspace install's wrapper sets it; empty means ~/.polygon-agent.
      POLYGON_AGENT_HOME: z.string().optional(),
      POLYGON_AGENT_ROOT: z.string().optional(),
      // Forces the sign-in method; any other value is ignored, as before.
      POLYGON_AGENT_SIGNIN: z
        .string()
        .optional()
        .transform((v) => (v === 'browser' || v === 'email' ? v : undefined)),
      // Baked-in defaults for the browser-login flow so `wallet login` needs no env
      // vars. Production domains, provisioned by the oidc-relay and agentconnect-ui
      // deploys on merge to main. Override per environment (or to test against staging).
      POLYGON_AGENT_OIDC_RELAY: httpUrl.default('https://oidc-relay.polygon.technology'),
      POLYGON_AGENT_LOGIN_UI: httpUrl.default('https://agentconnect.polygon.technology'),
      POLYGON_AGENT_CREDENTIALS_URL: httpUrl.optional(),
      POLYGON_AGENT_FUNDING_UI: httpUrl.optional(),

      SEQUENCE_INDEXER_URL: httpUrl.default(
        'https://indexer.sequence.app/rpc/IndexerGateway/GetTokenBalancesSummary'
      ),
      SEQUENCE_PROJECT_ACCESS_KEY: z.string().optional(),
      SEQUENCE_BUILDER_API_URL: httpUrl.default('https://api.sequence.build'),
      // A template: "{network}" is substituted at the call site, so it is not a plain URL.
      SEQUENCE_NODES_URL: z.string().optional(),
      SEQUENCE_OMS_PROJECT_ID: z.string().optional(),

      TRAILS_API_KEY: z.string().optional(),
      TRAILS_API_HOSTNAME: z.string().optional(),
      // Parsed where it is used, which reports invalid JSON with its own message.
      TRAILS_TOKEN_MAP_JSON: z.string().optional(),

      OMS_PUBLISHABLE_KEY: z.string().optional(),

      POLYMARKET_GAMMA_URL: httpUrl.default('https://gamma-api.polymarket.com'),
      POLYMARKET_CLOB_URL: httpUrl.default('https://clob.polymarket.com'),
      POLYMARKET_DATA_URL: httpUrl.default('https://data-api.polymarket.com'),
      POLYMARKET_BRIDGE_URL: httpUrl.default('https://bridge.polymarket.com'),
      POLYMARKET_GEOBLOCK_URL: httpUrl.default('https://polymarket.com/api/geoblock'),
      POLYMARKET_BUILDER_CODE: z.string().optional(),

      // True only for 1/true/yes (any case); anything else, including unset, is false and
      // never an error: it gates a money path, so a typo must not turn it on.
      SEQ_ECO_NATIVE_DIRECT: z
        .string()
        .optional()
        .transform((v) => ['1', 'true', 'yes'].includes((v ?? '').toLowerCase()))
    },
    // A copy: emptyStringAsUndefined deletes empty keys from the object it is given, which
    // would strip them from the real environment and every child process.
    runtimeEnv: { ...process.env },
    // env-core's default prints a raw issue dump; failures go through the JSON output instead.
    onValidationError: (issues) => {
      const bad = issues.map((issue) => {
        const segment = issue.path?.[0];
        const name = typeof segment === 'object' ? segment.key : segment;
        return `${String(name ?? 'environment')}: ${issue.message}`;
      });
      throw new CliError({
        code: 'invalid_env',
        message: `Invalid environment variable${bad.length > 1 ? 's' : ''} (${bad.join('; ')}).`,
        hint: 'Fix or unset the variable, then run the command again.'
      });
    },
    // Unset variables are often passed as empty strings; treat them as missing.
    emptyStringAsUndefined: true
  });
}

let cached: ReturnType<typeof buildEnv> | undefined;

export function getEnv(): ReturnType<typeof buildEnv> {
  cached ??= buildEnv();
  return cached;
}

/** Tests only: clears the memoised value so the next getEnv() re-reads process.env. */
export function resetEnv(): void {
  cached = undefined;
}
