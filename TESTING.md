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

Behaviour that needs a hosted service is listed as a gap in [docs/COVERAGE.md](docs/COVERAGE.md) rather than covered by a mock. Mocks are kept to a minimum: a test that mocks so much that it asserts little is labelled `weak` in the ledger and is not counted as coverage.

## The ledger

[docs/COVERAGE.md](docs/COVERAGE.md) has one row per command, tool, route or lifecycle, with what the tests assert and what they do not. Its legend defines the verdicts: `unit`, `weak`, `GAP`, and the tiers `A`, `A+` and `C` that rows can name.

Update the row in the same pull request that adds or removes a test, so the ledger never describes tests that are not there. A row's verdict only improves when a test earns it.

## Writing tests

- Import `describe`, `it`, `expect` and the hooks from `vitest`. Do not install `chai` separately.
- Assertions use vitest's standard `expect` matchers; no particular chain style is enforced in this repo. Assert on values and state, not only that a mock was called.
- Do not hard-code calendar dates that are compared with the real clock. Freeze time (`vi.useFakeTimers`, `vi.setSystemTime`) or build dates relative to now.
- Point state at a temp directory with `POLYGON_AGENT_HOME` so a test never touches a real install.
- Set timeouts as options on `describe` or `it`, for example `describe('name', { timeout: 30000 }, ...)`, not in config or on the command line.
- Clean up in `afterAll`, not in `process.on('exit')`.

## Packages

### `@polygonlabs/agent-cli` (`packages/polygon-agent-cli`)

Unit tests under `src/`, mostly in-process. Many use a real temporary filesystem for state and replace the wallet SDK, price and swap services with stand-ins. A few spawn real child processes (lock and waiter tests). There are no subprocess tests of the built binary.

### `@polygonlabs/oidc-relay` (`packages/oidc-relay`)

Unit tests for the request validators and for the login-session logic over an in-memory store. The fetch handler and the Durable Object class are not exercised.

### `@polygonlabs/agentconnect-ui` (`packages/agentconnect-ui`)

Worker tests (`worker/`) call handlers and Durable Object classes in Node with fakes for storage and the wallet client. SPA tests (`src/`) cover the login state machine, URL handling and dashboard helpers.

## Coverage

Coverage is measured for the CLI package (`packages/polygon-agent-cli`) on every test run (`pnpm test` runs vitest with `--coverage`). The floors in that package's `vitest.config.ts` are the measured baseline, not targets: a run that drops below a floor fails.

- Raise a floor in the same pull request that adds tests. Floors are never rewritten automatically.
- The directories that handle money (session, trade, polymarket, owner, the transaction helpers and `operations`) have their own floors, so a gain elsewhere cannot hide a loss there.
- The other two packages (`agentconnect-ui`, `oidc-relay`) are not measured yet.
