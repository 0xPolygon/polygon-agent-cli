# Testing

## Layout

Tests sit next to the code they cover, as `*.test.ts` files, and run under Vitest.

Two further suffixes are reserved so that tests which need a different runner can be told apart by name:

- `*.cli.test.ts` for subprocess tests of the built CLI.
- `*.workers.test.ts` for tests that run in a Workers runtime.

`*.network.test.ts` files call live services and are skipped unless `RUN_NETWORK_TESTS=1` is set.

## How to run

Use Node 24. The repo pins pnpm through `packageManager`, so run the pinned version (corepack, or `npx -y pnpm@10.30.3`).

```sh
pnpm --filter @polygonlabs/agent-cli run test
pnpm --filter @polygonlabs/oidc-relay run test
pnpm --filter @polygonlabs/agentconnect-ui run test
```

`pnpm run test` at the root runs all three. Run each package on its own while working: the failures stay attributable and the run is short.

## What the suite does and does not prove

No test moves real funds, and outside the opt-in network tests none calls a hosted wallet, swap or market service. Those services are replaced by stand-ins (in-process fakes, or local servers for the subprocess tests), so a passing suite says the code handles the responses its authors wrote down, not that a hosted service still answers that way.

Not covered by any test: behaviour that needs a hosted wallet, swap, price or market service (sending and swapping for real, balances, prices, market trading), and the worker's money operations inside its Durable Object. These are known gaps, left open rather than covered with mocks. Some older command tests mock most of what they call and mainly assert that the mocks were called; treat those as weak evidence.

## Writing tests

- Import `describe`, `it`, `expect` and the hooks from `vitest`. Do not install `chai` separately.
- Assertions use vitest's standard `expect` matchers; no particular chain style is enforced in this repo. Assert on values and state, not only that a mock was called.
- Do not hard-code calendar dates that are compared with the real clock. Freeze time (`vi.useFakeTimers`, `vi.setSystemTime`) or build dates relative to now.
- Point state at a temp directory with `POLYGON_AGENT_HOME` so a test never touches a real install.
- Set timeouts as options on `describe` or `it`, for example `describe('name', { timeout: 30000 }, ...)`, not in config or on the command line.
- Clean up in `afterAll`, not in `process.on('exit')`.

## Packages

### `@polygonlabs/agent-cli` (`packages/polygon-agent-cli`)

Unit tests under `src/`, mostly in-process. Many use a real temporary filesystem for state and replace the wallet SDK, price and swap services with stand-ins. A few spawn real child processes or shells (for example the lock and waiter tests).

`*.cli.test.ts` files run the built binary as a separate process (`src/test-harness/cli.ts`). The test run builds the CLI once, then each test starts `dist/index.js` with its own temporary HOME and state folder and an allowlisted environment, and reads stdout, stderr, the exit code and the files left on disk.

- Every child is pointed at a local proxy that records and refuses outbound requests. Assert `tripwireHits()` is empty, so "made no network call" is checked, not assumed. The proxy sees `fetch`, Node's default `http`/`https` agent and the global `WebSocket`; a library that brings its own agent or opens a raw socket is not seen and not blocked.
- A command that needs an upstream is given a local stand-in server on `127.0.0.1` through the command's own URL setting (`src/test-harness/fake-builder.ts`, `fake-x402.ts`). Nothing in these tests is mocked in-process.

### `@polygonlabs/oidc-relay` (`packages/oidc-relay`)

All tests run in a Workers runtime through `@cloudflare/vitest-pool-workers`, configured from the package's own `wrangler.toml`, so the `LoginSession` Durable Object and its storage are real. `src/relay.workers.test.ts` calls the fetch handler with `SELF.fetch` and uses no mocks; the worker makes no outbound calls. Storage is shared across the tests in a file, so each test uses its own session id. The expiry alarm is fired with `runDurableObjectAlarm` rather than by waiting.

### `@polygonlabs/agentconnect-ui` (`packages/agentconnect-ui`)

Worker tests (`worker/`) call handlers and Durable Object classes in Node with fakes for storage and the wallet client. SPA tests (`src/`) cover the login state machine, URL handling and dashboard helpers.

The package's `vitest.config.ts` has two projects. `node` runs the tests above. `workers` runs `worker/**/*.workers.test.ts` in a Workers runtime through `@cloudflare/vitest-pool-workers`: the real worker, a real SQLite-backed Durable Object, real KV and the real OAuth provider, with secrets generated for each run.

- The `workers` project loads `worker/index.ts` directly and declares its bindings in `vitest.config.ts`; it does not read `wrangler.toml`, whose bindings sit under environment blocks. A binding added there must be added to the test config too.
- All outbound requests in that runtime go to one handler, `worker/test-outbound/index.ts`. It matches on the request's hostname, records every request and refuses any host it does not know, so nothing reaches the network. To let a test reach another service, add that host there; do not mock modules.
- Tests call the worker with `SELF.fetch` and the key object through its own `fetch`, the way production does.
- Known limit: in this version of the test runtime a module loaded on demand inside a Durable Object never finishes loading. The key object loads its money dependencies that way, so sending, swapping, paying, earning, Polymarket and the approved run cannot be tested there yet.

## What comes next

The suite today covers what can be tested without real funds. The intended next step is end-to-end tests of the money flows on a testnet, with a funded testnet wallet, once the hosted services the CLI depends on offer a testnet or sandbox path. Until then those flows are not covered.
