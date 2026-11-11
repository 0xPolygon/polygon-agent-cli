# Testing

## Layout

Tests sit next to the code they cover, as `*.test.ts` files, and run under Vitest.

Two further suffixes are reserved so that tests which need a different runner can be told apart by name:

- `*.cli.test.ts` for subprocess tests of the built CLI.
- `*.workers.test.ts` for tests that run in a Workers runtime.

The package sections below say which of these each package uses.

## How to run

Use Node 24. The repo pins pnpm through `packageManager`, so run the pinned version (corepack, or `npx -y pnpm@10.30.3`).

```sh
pnpm --filter @polygonlabs/agent-cli run test
pnpm --filter @polygonlabs/oidc-relay run test
pnpm --filter @polygonlabs/agentconnect-ui run test
```

`pnpm run test` at the root runs all three. Run each package on its own while working: the failures stay attributable and the run is short.

## What the suite does and does not prove

No test moves real funds or calls a hosted wallet, swap or market service. Those services are faked in process, so a passing suite says the code handles the responses its authors wrote down, not that a hosted service still answers that way.

Not covered by any test: behaviour that needs a hosted wallet, swap, price or market service (sending and swapping for real, balances, prices, market trading), and the worker's money operations inside its Durable Object. These are known gaps, left open rather than covered with mocks. Some older command tests mock most of what they call and mainly assert that the mocks were called; treat those as weak evidence.

## Writing tests

- Import `describe`, `it`, `expect` and the hooks from `vitest`. Do not install `chai` separately.
- Assertions are Chai-style through `expect`; assert on values and state, not only that a mock was called.
- Do not hard-code calendar dates that are compared with the real clock. Freeze time (`vi.useFakeTimers`, `vi.setSystemTime`) or build dates relative to now.
- Point state at a temp directory with `POLYGON_AGENT_HOME` so a test never touches a real install.
- Set timeouts as options on `describe` or `it`, for example `describe('name', { timeout: 30000 }, ...)`, not in config or on the command line.
- Clean up in `afterAll`, not in `process.on('exit')`.

## Packages

### `@polygonlabs/agent-cli` (`packages/polygon-agent-cli`)

Unit tests under `src/`, mostly in-process. Many use a real temporary filesystem for state and replace the wallet SDK, price and swap services with stand-ins. A few spawn real child processes (lock and waiter tests). There are no subprocess tests of the built binary.

### `@polygonlabs/oidc-relay` (`packages/oidc-relay`)

All tests run in a Workers runtime through `@cloudflare/vitest-pool-workers`, configured from the package's own `wrangler.toml`, so the `LoginSession` Durable Object and its storage are real. `src/relay.workers.test.ts` calls the fetch handler with `SELF.fetch` and uses no mocks; the worker makes no outbound calls. Storage is shared across the tests in a file, so each test uses its own session id. The expiry alarm is fired with `runDurableObjectAlarm` rather than by waiting.

### `@polygonlabs/agentconnect-ui` (`packages/agentconnect-ui`)

Worker tests (`worker/`) call handlers and Durable Object classes in Node with fakes for storage and the wallet client. SPA tests (`src/`) cover the login state machine, URL handling and dashboard helpers.

## Coverage

Coverage is measured for the CLI package (`packages/polygon-agent-cli`) and the relay (`packages/oidc-relay`) on every test run (`pnpm test` runs vitest with `--coverage`). The floors in each package's `vitest.config.ts` are the measured baseline, not targets: a run that drops below a floor fails.

- Raise a floor in the same pull request that adds tests. Floors are never rewritten automatically.
- The directories that handle money (session, trade, polymarket, owner, the transaction helpers and `operations`) have their own floors, so a gain elsewhere cannot hide a loss there.
- The relay is measured with the istanbul provider, because v8 coverage is not available inside the Workers runtime.
- `agentconnect-ui` is not measured yet.
