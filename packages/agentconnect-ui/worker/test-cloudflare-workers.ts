// Test-only stand-in for the `cloudflare:workers` module, which only exists in
// the Workers runtime. The OAuth provider imports WorkerEntrypoint from it.
export class WorkerEntrypoint {}
