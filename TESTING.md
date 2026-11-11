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

No test moves real funds, and outside the opt-in network tests none calls a hosted wallet, swap or market service. Those services are faked in process, so a passing suite says the code handles the responses its authors wrote down, not that a hosted service still answers that way.

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

Unit tests under `src/`, mostly in-process. Many use a real temporary filesystem for state and replace the wallet SDK, price and swap services with stand-ins. A few spawn real child processes or shells (for example the lock and waiter tests). There are no subprocess tests of the built binary.

### `@polygonlabs/oidc-relay` (`packages/oidc-relay`)

Unit tests for the request validators and for the login-session logic over an in-memory store. The fetch handler and the Durable Object class are not exercised.

### `@polygonlabs/agentconnect-ui` (`packages/agentconnect-ui`)

Worker tests (`worker/`) call handlers and Durable Object classes in Node with fakes for storage and the wallet client. SPA tests (`src/`) cover the login state machine, URL handling and dashboard helpers.

## What comes next

The suite today covers what can be tested without real funds. The intended next step is end-to-end tests of the money flows on a testnet, with a funded testnet wallet, once the hosted services the CLI depends on offer a testnet or sandbox path. Until then those flows are not covered.
