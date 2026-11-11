/// <reference types="@cloudflare/vitest-pool-workers" />

// The bindings vitest.config.ts declares for the Workers project, typed non-optional.
declare module 'cloudflare:test' {
  interface ProvidedEnv {
    AGENT_KEYS: DurableObjectNamespace;
    OAUTH_KV: KVNamespace;
    AGENT_CERT_SECRET: string;
    CREDENTIALS_KEY: string;
  }
}
