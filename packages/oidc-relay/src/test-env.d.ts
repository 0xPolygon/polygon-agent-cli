/// <reference types="@cloudflare/vitest-pool-workers" />

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    LOGIN_SESSION: DurableObjectNamespace;
  }
}
