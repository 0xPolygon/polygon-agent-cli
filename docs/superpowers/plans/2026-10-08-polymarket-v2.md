# Polymarket V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent with an OMS wallet trade on Polymarket through a CLI-managed Deposit Wallet. It funds and withdraws through Polymarket's bridge, needs no key import and no POL, and works in session mode.

**Architecture:** The Polymarket code moves into `src/lib/polymarket/` (one file per concern) and `src/commands/polymarket/` (one file per command group).
- **Trading account:** a CLI-generated trading key drives `@polymarket/client`. The client deploys and operates a Polymarket Deposit Wallet through Polymarket's relayer, authorized by a builder API key the CLI mints.
- **Deposits:** `runTx` sends a plain USDC transfer to a Polymarket bridge address, so session-mode allowances apply.
- **Withdrawals:** `transferErc20` (gasless) sends pUSD to a bridge address that pays the OMS wallet.

**Tech Stack:** TypeScript (Node ≥ 22 for the published CLI, 24 in dev), yargs, vitest, viem, `@polymarket/client@0.12.0`.

**Spec:** `docs/superpowers/specs/2026-10-08-polymarket-v2-design.md`.
**SDK reference** (verified signatures, shapes and gotchas): `docs/superpowers/specs/2026-10-08-polymarket-client-sdk-reference.md`.

## Global Constraints

- All paths are relative to `packages/polygon-agent-cli/` unless they start with `skills/`, `docs/` or `.changeset/`.
- **Dependency:** `@polymarket/client` is pinned exactly at `0.12.0`. It declares `engines.node >= 24`, so import it only with `await import(...)` inside `src/lib/polymarket/`, never at module top level and never from `src/index.ts`.
- All output is JSON on stdout. Failures go to stderr through `errorJson`/`failureJson` from `src/lib/errors.ts`, followed by `process.exit(1)`.
- **Write commands:**
  - They use `withWriteFlags` and `resolveBroadcast` from `src/lib/mode.ts`, and are dry-run unless `--broadcast` is passed or the mode is `auto`.
  - Write commands: `setup`, `deposit`, `withdraw`, `buy`, `sell`, `cancel`, `redeem`.
  - **Tests always pass `--dry-run` or mock the SDK.** The persisted mode on a dev machine may be `auto`.
- Every new error code is added to `PolymarketErrorCode` in `src/lib/errors.ts`. Raise them as `new PolymarketError(code, message)` from `src/lib/polymarket/gamma.ts` (moved in Task 1).
- **Secrets:**
  - Store them only with `encrypt`/`decrypt` from `src/lib/storage.ts`, under `$POLYGON_AGENT_HOME/polymarket/<wallet>/`.
  - Write with `writeJsonFile` from `src/lib/session/state.ts` (atomic, mode 0600).
  - Never print a private key or builder secret.
- **Session-mode spends:**
  - Go only through `runTx` from `src/lib/tx-dispatch.ts`, as one plain ERC-20 `transfer` with `purpose: 'trade'` and `ref: 'polymarket-deposit'`.
  - Never call `.prepareTransaction`/`.executeTransaction`; ESLint forbids it outside `src/lib/session/transfer.ts`.
- **Amounts:** USD amounts are parsed to 6-decimal base units with `parseUnits` (viem), after rejecting more than 6 decimals with `invalid_input`. Never use `Math.round(x * 1e6)`.
- **Addresses:**
  - Polygon USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (6 decimals)
  - USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` (6 decimals)
  - pUSD `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB` (6 decimals)
- **Bridge:** base URL `https://bridge.polymarket.com`; the minimum deposit is $2 (`minCheckoutUsd` for Polygon USDC); geoblock is `https://polymarket.com/api/geoblock`. Base URLs are overridable with `POLYMARKET_BRIDGE_URL` and `POLYMARKET_GEOBLOCK_URL`.
- **Builder code:** orders and bridge calls pass `builderCode` / `X-Builder-Code` only when `POLYMARKET_BUILDER_CODE` is set (bytes32 hex). There is no default.
- Commit messages carry no Co-Authored-By line.

## Review Focus

1. **Re-running `deposit` after an interrupted run must not send twice.** A deposit whose transfer went out but whose credit hasn't landed is recorded in `deposits.json`. A rerun reports `bridge_pending` with the earlier tx hash instead of sending, unless `--again` is passed. Pinned in Task 6.
2. **USD inputs with more than 6 decimals, zero, negative or non-numeric** fail with `invalid_input` before any network call; `"10.5"` becomes `10500000n`. Pinned in Task 2.
3. **`sell <m> <o> all` when the position is 0** fails with `insufficient_shares`; it never posts a zero-size order. Pinned in Task 8.
4. **A market buy whose estimated fill is worse than `--max-price`** fails with `price_guard`, and no order is posted. When the estimate is fine, `maxPrice` is still passed to the SDK so the venue enforces it too. Pinned in Task 8.
5. **A command for a wallet that never ran `setup`** fails with `not_set_up` and a `command` hint of `agent polymarket setup --wallet <name> --broadcast`. It never silently creates a key outside `setup`. Pinned in Task 3.

---

## File structure

```
src/lib/polymarket/
  gamma.ts       (moved from src/lib/polymarket.ts: Gamma + Data API v2 reads, PolymarketError, constants, legacy proxy helpers)
  gamma.test.ts  (moved from src/lib/polymarket.test.ts)
  amounts.ts     parseUsd(), formatUnits6()
  account.ts     trading key + builder creds storage, getTradingClient(), setupAccount(), accountSummary()
  bridge.ts      depositAddress(), withdrawAddress(), bridgeStatus()
  deposits.ts    pending-deposit record (idempotent deposit)
  region.ts      checkRegion(), assertCanOpen(), assertCanTrade()
  resolve.ts     resolveOutcome(): market ref + outcome name -> { market, outcome, assetId }
  orders.ts      buy(), sell(), normalizeOrderResponse()
  sdk.ts         loadSdk(): lazy import of @polymarket/client and its subpaths, mapSdkError()
src/commands/polymarket/
  index.ts       polymarketCommand: registers every subcommand and the hidden aliases
  account.ts     setup, status, import-key
  funds.ts       deposit, withdraw
  discover.ts    markets, event, market, book, history
  trade.ts       buy, sell, orders, cancel
  portfolio.ts   positions, redeem, activity, pnl
  shared.ts      walletOption(), printFail(), positional parsers
```

The old `src/commands/polymarket.ts` and its two test files are deleted in Task 10, after their behavior has moved.

---

### Task 1: Move the existing Polymarket lib, add the SDK and error codes

**Files:**
- Move: `src/lib/polymarket.ts` → `src/lib/polymarket/gamma.ts`
- Move: `src/lib/polymarket.test.ts` → `src/lib/polymarket/gamma.test.ts`
- Create: `src/lib/polymarket/sdk.ts`, `src/lib/polymarket/sdk.test.ts`
- Modify: `src/lib/errors.ts` (the `PolymarketErrorCode` union), `package.json`, every importer of `../lib/polymarket.ts`

**Interfaces:**
- Produces:
  - `loadSdk(): Promise<Sdk>`, where `Sdk = { root: typeof import('@polymarket/client'); viem: typeof import('@polymarket/client/viem'); node: typeof import('@polymarket/client/node'); actions: typeof import('@polymarket/client/actions') }`
  - `mapSdkError(err: unknown): unknown` (returns a `PolymarketError`/`CliError` when it recognizes the error, otherwise the input)
  - `PolymarketErrorCode` gains: `not_set_up | below_bridge_minimum | insufficient_pusd | insufficient_shares | bridge_pending | region_blocked | region_close_only | price_guard | outcome_not_found | ambiguous_market | order_rejected`

- [ ] **Step 1: Move the files with git and fix imports**

```bash
cd packages/polygon-agent-cli
mkdir -p src/lib/polymarket
git mv src/lib/polymarket.ts src/lib/polymarket/gamma.ts
git mv src/lib/polymarket.test.ts src/lib/polymarket/gamma.test.ts
grep -rl "lib/polymarket.ts\|'./polymarket.ts'" src | xargs sed -i '' "s#lib/polymarket.ts#lib/polymarket/gamma.ts#g"
```
In `src/lib/polymarket/gamma.ts`, change `from './errors.ts'` to `from '../errors.ts'`. In `gamma.test.ts`, change the import from `./polymarket.ts` to `./gamma.ts`.

- [ ] **Step 2: Add the dependency**

```bash
pnpm add --filter @polygonlabs/agent-cli @polymarket/client@0.12.0 --save-exact
```
Expected: `package.json` lists `"@polymarket/client": "0.12.0"`. Run `pnpm install` if the lockfile needs it.

- [ ] **Step 3: Add the error codes**

In `src/lib/errors.ts`, replace the `PolymarketErrorCode` type with:
```ts
export type PolymarketErrorCode =
  | 'offset_removed'
  | 'unsupported_market_version'
  | 'market_not_accepting_orders'
  | 'not_set_up'
  | 'below_bridge_minimum'
  | 'insufficient_pusd'
  | 'insufficient_shares'
  | 'bridge_pending'
  | 'region_blocked'
  | 'region_close_only'
  | 'price_guard'
  | 'outcome_not_found'
  | 'ambiguous_market'
  | 'order_rejected';
```

- [ ] **Step 4: Write the failing test for `sdk.ts`**

`src/lib/polymarket/sdk.test.ts`:
```ts
import { describe, expect, it } from 'vitest';

import { CliError } from '../errors.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

describe('loadSdk', () => {
  it('lazily loads the SDK root and subpaths', async () => {
    const sdk = await loadSdk();
    expect(typeof sdk.root.createSecureClient).toBe('function');
    expect(typeof sdk.viem.privateKey).toBe('function');
    expect(typeof sdk.node.builderApiKey).toBe('function');
    expect(typeof sdk.actions.createBuilderApiKey).toBe('function');
  });
});

describe('mapSdkError', () => {
  it('maps a 429 to rate_limited', async () => {
    const { root } = await loadSdk();
    const err = new root.RateLimitError('slow down');
    const mapped = mapSdkError(err) as CliError;
    expect(mapped).toBeInstanceOf(CliError);
    expect(mapped.code).toBe('rate_limited');
  });

  it('maps a transport failure to upstream_unavailable', async () => {
    const { root } = await loadSdk();
    const mapped = mapSdkError(new root.TransportError('boom')) as CliError;
    expect(mapped.code).toBe('upstream_unavailable');
  });

  it('maps a UserInputError to invalid_input and keeps the message', async () => {
    const { root } = await loadSdk();
    const mapped = mapSdkError(new root.UserInputError('amount: too small')) as CliError;
    expect(mapped.code).toBe('invalid_input');
    expect(mapped.message).toMatch(/amount: too small/);
  });

  it('passes through errors it does not know', () => {
    const err = new Error('other');
    expect(mapSdkError(err)).toBe(err);
  });
});
```

- [ ] **Step 5: Run it and confirm it fails**

Run: `npx vitest run src/lib/polymarket/sdk.test.ts`
Expected: FAIL, because `./sdk.ts` doesn't exist.

- [ ] **Step 6: Implement `sdk.ts`**

```ts
// Lazy access to @polymarket/client. The SDK declares Node >= 24 while the CLI
// supports 22, so it is only loaded when a Polymarket command runs.

import { CliError } from '../errors.ts';

export type Sdk = {
  root: typeof import('@polymarket/client');
  viem: typeof import('@polymarket/client/viem');
  node: typeof import('@polymarket/client/node');
  actions: typeof import('@polymarket/client/actions');
};

let cached: Sdk | undefined;
let rootRef: Sdk['root'] | undefined;

export async function loadSdk(): Promise<Sdk> {
  if (cached) return cached;
  const [root, viem, node, actions] = await Promise.all([
    import('@polymarket/client'),
    import('@polymarket/client/viem'),
    import('@polymarket/client/node'),
    import('@polymarket/client/actions')
  ]);
  rootRef = root;
  cached = { root, viem, node, actions };
  return cached;
}

// Class checks use `instanceof`: the SDK's static `isError` matches any
// Polymarket error, not just the named class.
export function mapSdkError(err: unknown): unknown {
  const r = rootRef;
  if (!r || err instanceof CliError) return err;
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof r.RateLimitError) {
    return new CliError({ code: 'rate_limited', message, cause: err });
  }
  if (err instanceof r.TransportError || err instanceof r.TimeoutError) {
    return new CliError({ code: 'upstream_unavailable', message, cause: err });
  }
  if (err instanceof r.UserInputError) {
    return new CliError({ code: 'invalid_input', message, cause: err });
  }
  if (err instanceof r.RequestRejectedError) {
    const status = (err as { status?: number }).status;
    return new CliError({
      code: status !== undefined && status >= 500 ? 'upstream_unavailable' : 'upstream_error',
      message,
      cause: err
    });
  }
  return err;
}
```

- [ ] **Step 7: Run the tests and the full suite**

Run: `npx vitest run src/lib/polymarket src/commands && pnpm typecheck && pnpm lint`
Expected: everything passes (lint shows only the existing warnings).

- [ ] **Step 8: Commit**

```bash
git add -A src/lib/polymarket src/lib/polymarket.ts src/lib/polymarket.test.ts src/lib/errors.ts src/commands package.json ../../pnpm-lock.yaml
git commit -m "refactor(polymarket): move lib under lib/polymarket and add @polymarket/client"
```

---

### Task 2: Amount parsing

**Files:**
- Create: `src/lib/polymarket/amounts.ts`, `src/lib/polymarket/amounts.test.ts`

**Interfaces:**
- Produces:
  - `parseUsd(input: string | number, field?: string): bigint` (6-decimal base units; throws `CliError invalid_input`)
  - `formatUnits6(units: bigint | string): string`
  - `parseShares(input: string | number): number | 'all'`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { formatUnits6, parseShares, parseUsd } from './amounts.ts';

describe('parseUsd', () => {
  it('parses whole and fractional dollars into 6-decimal units', () => {
    expect(parseUsd('10')).toBe(10_000_000n);
    expect(parseUsd('10.5')).toBe(10_500_000n);
    expect(parseUsd(0.000001)).toBe(1n);
  });

  it.each(['0', '-1', 'abc', '', '1.0000001', 'NaN', 'Infinity'])('rejects %s', (bad) => {
    expect(() => parseUsd(bad)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('formatUnits6', () => {
  it('formats base units as a decimal string', () => {
    expect(formatUnits6(10_500_000n)).toBe('10.5');
    expect(formatUnits6('1')).toBe('0.000001');
  });
});

describe('parseShares', () => {
  it('accepts a positive number or all', () => {
    expect(parseShares('12.5')).toBe(12.5);
    expect(parseShares('all')).toBe('all');
    expect(parseShares('ALL')).toBe('all');
  });

  it.each(['0', '-3', 'x'])('rejects %s', (bad) => {
    expect(() => parseShares(bad)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/polymarket/amounts.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement it**

```ts
// USD and share amounts for Polymarket commands. pUSD and USDC use 6 decimals.

import { formatUnits, parseUnits } from 'viem';

import { CliError } from '../errors.ts';

export function parseUsd(input: string | number, field = 'amount'): bigint {
  const text = String(input).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new CliError({
      code: 'invalid_input',
      message: `${field} must be a positive USD amount with at most 6 decimals, got '${input}'.`
    });
  }
  const units = parseUnits(text, 6);
  if (units <= 0n) {
    throw new CliError({ code: 'invalid_input', message: `${field} must be greater than 0.` });
  }
  return units;
}

export function formatUnits6(units: bigint | string): string {
  return formatUnits(BigInt(units), 6);
}

export function parseShares(input: string | number): number | 'all' {
  const text = String(input).trim();
  if (text.toLowerCase() === 'all') return 'all';
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError({
      code: 'invalid_input',
      message: `shares must be a positive number or 'all', got '${input}'.`
    });
  }
  return n;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/polymarket/amounts.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polymarket/amounts.ts src/lib/polymarket/amounts.test.ts
git commit -m "feat(polymarket): USD and share amount parsing"
```

---

### Task 3: Trading account (key, builder creds, client, setup)

**Files:**
- Create: `src/lib/polymarket/account.ts`, `src/lib/polymarket/account.test.ts`

**Interfaces:**
- Consumes: `loadSdk`, `mapSdkError` (Task 1); `encrypt`, `decrypt`, `STORAGE_ROOT`, `loadPolymarketKey` from `../storage.ts`; `readJsonFile`, `writeJsonFile` from `../session/state.ts`.
- Produces:
  - `type AccountKind = 'deposit-wallet' | 'legacy-proxy'`
  - `type StoredAccount = { kind: AccountKind; signer: string; wallet: string; createdAt: string }`
  - `accountDir(wallet: string): string`
  - `loadAccount(wallet: string): StoredAccount | null`
  - `requireAccount(wallet: string): StoredAccount` (throws `not_set_up`)
  - `getTradingClient(wallet: string): Promise<SecureClient>` (an existing account only; throws `not_set_up`)
  - `setupAccount(wallet: string): Promise<{ account: StoredAccount; created: boolean; approvalsSet: boolean }>`
  - `planSetup(wallet: string): { exists: boolean; account: StoredAccount | null }`
  - `importLegacyKey(wallet: string, privateKey: string): Promise<StoredAccount>`
  - `pusdBalance(wallet: string): Promise<bigint>`

Storage layout under `$POLYGON_AGENT_HOME/polymarket/<wallet>/`:
- `key.json`: `CipherData` of the trading key
- `builder.json`: `CipherData` of `JSON.stringify({key, secret, passphrase})`
- `clob.json`: `CipherData` of the CLOB L2 creds, `JSON.stringify(client.credentials)`, so later runs skip re-auth
- `account.json`: `StoredAccount` (plaintext; no secrets)

- [ ] **Step 1: Write the failing test** (the SDK is mocked; no network)

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-account-'));

const sdk = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  const client = (wallet: string) => ({
    account: { signer: '0x1111111111111111111111111111111111111111', wallet, walletType: 3 },
    credentials: { key: 'clob-key', secret: 'clob-secret', passphrase: 'clob-pass' },
    fetchTradingApprovalsState: vi.fn(async () => ({ isFullyApproved: false, missing: {} })),
    setupTradingApprovals: vi.fn(async () => undefined)
  });
  return {
    created,
    createSecureClient: vi.fn(async (opts: Record<string, unknown>) => {
      created.push(opts);
      return client((opts.wallet as string) ?? '0xD0000000000000000000000000000000000000D0');
    }),
    createBuilderApiKey: vi.fn(async () => ({ key: 'b-key', secret: 'b-secret', passphrase: 'b-pass' })),
    fetchBalanceAllowance: vi.fn(async () => ({ balance: '2500000', allowances: {} }))
  };
});

vi.mock('./sdk.ts', async (orig) => ({
  ...(await orig<typeof import('./sdk.ts')>()),
  loadSdk: async () => ({
    root: { createSecureClient: sdk.createSecureClient, AssetType: { COLLATERAL: 'COLLATERAL' } },
    viem: { privateKey: (k: string) => ({ __pk: k }) },
    node: { builderApiKey: (c: unknown) => ({ __builder: c }) },
    actions: {
      createBuilderApiKey: sdk.createBuilderApiKey,
      fetchBalanceAllowance: sdk.fetchBalanceAllowance
    }
  })
}));

const account = await import('./account.ts');

beforeEach(() => {
  sdk.created.length = 0;
  vi.clearAllMocks();
  fs.rmSync(path.join(String(process.env.POLYGON_AGENT_HOME), 'polymarket'), { recursive: true, force: true });
});

describe('setupAccount', () => {
  it('creates a key, mints a builder key as the EOA, then deploys the deposit wallet and sets approvals', async () => {
    const res = await account.setupAccount('main');
    expect(res.created).toBe(true);
    expect(res.approvalsSet).toBe(true);
    // first client: EOA mode (wallet = signer) to mint the builder key
    expect(sdk.created[0].wallet).toBe('0x1111111111111111111111111111111111111111');
    // second client: deposit wallet (no wallet option) with the builder key
    expect(sdk.created[1].wallet).toBeUndefined();
    expect(sdk.created[1].apiKey).toEqual({ __builder: { key: 'b-key', secret: 'b-secret', passphrase: 'b-pass' } });
    expect(res.account).toMatchObject({ kind: 'deposit-wallet', wallet: '0xD0000000000000000000000000000000000000D0' });
  });

  it('is idempotent: a second run reuses the key and builder key', async () => {
    await account.setupAccount('main');
    sdk.created.length = 0;
    const res = await account.setupAccount('main');
    expect(res.created).toBe(false);
    expect(sdk.createBuilderApiKey).toHaveBeenCalledTimes(1);
    expect(sdk.created).toHaveLength(1);
  });

  it('never writes the private key or builder secret in plaintext', async () => {
    await account.setupAccount('main');
    const dir = account.accountDir('main');
    for (const f of fs.readdirSync(dir)) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(text).not.toMatch(/b-secret|clob-secret/);
      expect(text).not.toMatch(/"0x[0-9a-f]{64}"/i);
    }
  });
});

describe('requireAccount / getTradingClient', () => {
  it('fails with not_set_up and a command hint for a wallet without setup', async () => {
    expect(() => account.requireAccount('other')).toThrow(
      expect.objectContaining({
        code: 'not_set_up',
        command: 'agent polymarket setup --wallet other --broadcast'
      })
    );
    await expect(account.getTradingClient('other')).rejects.toMatchObject({ code: 'not_set_up' });
    expect(sdk.created).toHaveLength(0);
  });

  it('reuses stored CLOB credentials', async () => {
    await account.setupAccount('main');
    sdk.created.length = 0;
    await account.getTradingClient('main');
    expect(sdk.created[0].credentials).toEqual({ key: 'clob-key', secret: 'clob-secret', passphrase: 'clob-pass' });
  });
});

describe('pusdBalance', () => {
  it('reads the collateral balance in base units', async () => {
    await account.setupAccount('main');
    expect(await account.pusdBalance('main')).toBe(2_500_000n);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/lib/polymarket/account.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `account.ts`**

```ts
// The Polymarket trading account for an OMS wallet name: a CLI-generated key
// that controls a Polymarket Deposit Wallet. Polymarket's relayer deploys the
// wallet and runs its approvals and transfers, authorized by a builder API key
// minted from the same key. The OMS wallet never signs for Polymarket.

import fs from 'node:fs';
import path from 'node:path';

import type { CipherData } from '../storage.ts';

import { CliError } from '../errors.ts';
import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { decrypt, encrypt, STORAGE_ROOT } from '../storage.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

export type AccountKind = 'deposit-wallet' | 'legacy-proxy';
export type StoredAccount = { kind: AccountKind; signer: string; wallet: string; createdAt: string };
type Creds = { key: string; secret: string; passphrase: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SecureClient = any;

export function accountDir(wallet: string): string {
  const dir = path.join(STORAGE_ROOT, 'polymarket', wallet);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readSecret(wallet: string, name: string): string | null {
  const data = readJsonFile(path.join(accountDir(wallet), name)) as CipherData | undefined;
  return data ? decrypt(data) : null;
}

function writeSecret(wallet: string, name: string, value: string): void {
  writeJsonFile({ file: path.join(accountDir(wallet), name), data: encrypt(value) });
}

export function loadAccount(wallet: string): StoredAccount | null {
  return (readJsonFile(path.join(accountDir(wallet), 'account.json')) as StoredAccount) ?? null;
}

export function requireAccount(wallet: string): StoredAccount {
  const acct = loadAccount(wallet);
  if (!acct) {
    throw new CliError({
      code: 'not_set_up',
      message: `No Polymarket account for wallet '${wallet}' yet.`,
      command: `agent polymarket setup --wallet ${wallet} --broadcast`
    });
  }
  return acct;
}

export function planSetup(wallet: string): { exists: boolean; account: StoredAccount | null } {
  const account = loadAccount(wallet);
  return { exists: account !== null, account };
}

async function clientFor(
  wallet: string,
  acct: { kind: AccountKind; wallet?: string },
  key: string
): Promise<SecureClient> {
  const { root, viem, node } = await loadSdk();
  const builderText = readSecret(wallet, 'builder.json');
  const clobText = readSecret(wallet, 'clob.json');
  try {
    const client = await root.createSecureClient({
      signer: viem.privateKey(key),
      ...(acct.kind === 'legacy-proxy' ? { wallet: acct.wallet } : {}),
      ...(builderText ? { apiKey: node.builderApiKey(JSON.parse(builderText) as Creds) } : {}),
      ...(clobText ? { credentials: JSON.parse(clobText) as Creds } : {})
    } as never);
    if (!clobText && client.credentials) writeSecret(wallet, 'clob.json', JSON.stringify(client.credentials));
    return client;
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function getTradingClient(wallet: string): Promise<SecureClient> {
  const acct = requireAccount(wallet);
  const key = readSecret(wallet, 'key.json');
  if (!key) throw requireAccountError(wallet);
  return clientFor(wallet, acct, key);
}

function requireAccountError(wallet: string): CliError {
  return new CliError({
    code: 'not_set_up',
    message: `The Polymarket key for wallet '${wallet}' is missing.`,
    command: `agent polymarket setup --wallet ${wallet} --broadcast`
  });
}

export async function setupAccount(
  wallet: string
): Promise<{ account: StoredAccount; created: boolean; approvalsSet: boolean }> {
  const existing = loadAccount(wallet);
  const { root, viem, actions } = await loadSdk();
  const { generatePrivateKey, privateKeyToAccount } = await import('viem/accounts');

  let key = readSecret(wallet, 'key.json');
  if (!key) {
    key = generatePrivateKey();
    writeSecret(wallet, 'key.json', key);
  }
  const signer = privateKeyToAccount(key as `0x${string}`).address;

  if (!readSecret(wallet, 'builder.json')) {
    try {
      // The builder key is minted as the EOA itself; no deposit wallet is needed for that.
      const eoaClient = await root.createSecureClient({ signer: viem.privateKey(key), wallet: signer } as never);
      const creds = await actions.createBuilderApiKey(eoaClient as never);
      writeSecret(wallet, 'builder.json', JSON.stringify(creds));
    } catch (err) {
      throw mapSdkError(err);
    }
  }

  // Creating the client deploys the deposit wallet through the relayer when needed.
  const client = await clientFor(wallet, existing ?? { kind: 'deposit-wallet' }, key);
  const account: StoredAccount = existing ?? {
    kind: 'deposit-wallet',
    signer,
    wallet: client.account.wallet,
    createdAt: new Date().toISOString()
  };
  if (!existing) writeJsonFile({ file: path.join(accountDir(wallet), 'account.json'), data: account });

  let approvalsSet = false;
  try {
    const state = await client.fetchTradingApprovalsState();
    if (!state.isFullyApproved) {
      await client.setupTradingApprovals();
      approvalsSet = true;
    }
  } catch (err) {
    throw mapSdkError(err);
  }
  return { account, created: !existing, approvalsSet };
}

// Legacy: an imported Polymarket key whose funds sit in a Polymarket proxy wallet.
export async function importLegacyKey(wallet: string, privateKey: string): Promise<StoredAccount> {
  const { getPolymarketProxyWalletAddress } = await import('./gamma.ts');
  const { privateKeyToAccount } = await import('viem/accounts');
  const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new CliError({ code: 'invalid_input', message: 'The private key must be 32 bytes of hex.' });
  }
  const signer = privateKeyToAccount(pk as `0x${string}`).address;
  const account: StoredAccount = {
    kind: 'legacy-proxy',
    signer,
    wallet: await getPolymarketProxyWalletAddress(signer),
    createdAt: new Date().toISOString()
  };
  writeSecret(wallet, 'key.json', pk);
  writeJsonFile({ file: path.join(accountDir(wallet), 'account.json'), data: account });
  return account;
}

export async function pusdBalance(wallet: string): Promise<bigint> {
  const client = await getTradingClient(wallet);
  const { root, actions } = await loadSdk();
  try {
    const res = await actions.fetchBalanceAllowance(client, { assetType: root.AssetType.COLLATERAL } as never);
    return BigInt(res.balance);
  } catch (err) {
    throw mapSdkError(err);
  }
}
```

If the test's `readdirSync` sees `*.tmp-*` leftovers, `writeJsonFile` renamed late. It shouldn't; investigate before weakening the test.

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run src/lib/polymarket/account.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polymarket/account.ts src/lib/polymarket/account.test.ts
git commit -m "feat(polymarket): CLI-managed trading key and Deposit Wallet account"
```

---

### Task 4: Region checks

**Files:**
- Create: `src/lib/polymarket/region.ts`, `src/lib/polymarket/region.test.ts`

**Interfaces:**
- Produces:
  - `type Region = { blocked: boolean; closeOnly: boolean; country: string | null; region: string | null }`
  - `checkRegion(client?: SecureClient): Promise<Region>`. It uses the geoblock endpoint for `blocked` and `country`, and `client.fetchClosedOnlyMode()` for `closeOnly` when a client is given.
  - `assertCanOpen(r: Region): void` throws `region_blocked` or `region_close_only`.
  - `assertCanTrade(r: Region): void` throws `region_blocked` only.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertCanOpen, assertCanTrade, checkRegion } from './region.ts';

function geo(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => vi.unstubAllGlobals());

describe('checkRegion', () => {
  it('reports country and blocked from the geoblock endpoint', async () => {
    geo({ blocked: false, ip: 'x', country: 'PT', region: '11' });
    expect(await checkRegion()).toEqual({ blocked: false, closeOnly: false, country: 'PT', region: '11' });
  });

  it('marks close-only when the CLOB says so', async () => {
    geo({ blocked: false, country: 'US', region: 'NY' });
    const r = await checkRegion({ fetchClosedOnlyMode: async () => true });
    expect(r.closeOnly).toBe(true);
  });

  it('treats an unreachable geoblock endpoint as upstream_unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    await expect(checkRegion()).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});

describe('asserts', () => {
  const base = { country: 'US', region: null };
  it('blocks opening in a close-only region but allows trading out', () => {
    const r = { ...base, blocked: false, closeOnly: true };
    expect(() => assertCanOpen(r)).toThrow(expect.objectContaining({ code: 'region_close_only' }));
    expect(() => assertCanTrade(r)).not.toThrow();
  });
  it('blocks everything in a blocked region', () => {
    const r = { ...base, blocked: true, closeOnly: true };
    expect(() => assertCanOpen(r)).toThrow(expect.objectContaining({ code: 'region_blocked' }));
    expect(() => assertCanTrade(r)).toThrow(expect.objectContaining({ code: 'region_blocked' }));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Run: `npx vitest run src/lib/polymarket/region.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement it**

```ts
// Polymarket region rules. Blocked regions can't trade at all; close-only
// regions (the US among them) can sell, cancel, redeem and withdraw but not buy.

import { CliError } from '../errors.ts';
import { PolymarketError } from './gamma.ts';

export type Region = { blocked: boolean; closeOnly: boolean; country: string | null; region: string | null };

const GEOBLOCK_URL = process.env.POLYMARKET_GEOBLOCK_URL || 'https://polymarket.com/api/geoblock';

export async function checkRegion(client?: { fetchClosedOnlyMode(): Promise<boolean> }): Promise<Region> {
  let body: { blocked?: boolean; country?: string; region?: string };
  try {
    const res = await fetch(GEOBLOCK_URL);
    if (!res.ok) throw new Error(`geoblock ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    throw new CliError({
      code: 'upstream_unavailable',
      message: `Couldn't check Polymarket's region rules: ${(err as Error).message}`,
      cause: err
    });
  }
  const closeOnly = client ? await client.fetchClosedOnlyMode() : false;
  return {
    blocked: body.blocked === true,
    closeOnly: closeOnly || body.blocked === true,
    country: body.country ?? null,
    region: body.region ?? null
  };
}

export function assertCanTrade(r: Region): void {
  if (r.blocked) {
    throw new PolymarketError('region_blocked', `Polymarket isn't available from ${r.country ?? 'this region'}.`);
  }
}

export function assertCanOpen(r: Region): void {
  assertCanTrade(r);
  if (r.closeOnly) {
    throw new PolymarketError(
      'region_close_only',
      `Polymarket only allows closing positions from ${r.country ?? 'this region'}: sell, cancel, redeem and withdraw still work.`
    );
  }
}
```

- [ ] **Step 4: Run it and confirm it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polymarket/region.ts src/lib/polymarket/region.test.ts
git commit -m "feat(polymarket): geoblock and close-only checks"
```

---

### Task 5: Bridge client

**Files:**
- Create: `src/lib/polymarket/bridge.ts`, `src/lib/polymarket/bridge.test.ts`

**Interfaces:**
- Produces:
  - `BRIDGE_MIN_DEPOSIT_UNITS = 2_000_000n`
  - `depositAddress(wallet: string): Promise<string>` (the bridge's EVM deposit address for a Polymarket wallet)
  - `withdrawAddress(params: { wallet: string; recipient: string; toChainId?: number; toToken?: string }): Promise<string>` (defaults: chain 137, Polygon USDC)
  - `bridgeStatus(address: string): Promise<{ transactions: Array<{ status: string; [k: string]: unknown }> }>`
  - `builderHeaders(): Record<string, string>`

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bridgeStatus, depositAddress, withdrawAddress } from './bridge.ts';

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.POLYMARKET_BUILDER_CODE;
});

describe('depositAddress', () => {
  it('posts the wallet and returns the evm address', async () => {
    const fn = mockFetch({ address: { evm: '0xB1', svm: 'S', btc: 'b' } });
    expect(await depositAddress('0xW')).toBe('0xB1');
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe('https://bridge.polymarket.com/deposit');
    expect(JSON.parse(init.body)).toEqual({ address: '0xW' });
    expect(init.headers['X-Builder-Code']).toBeUndefined();
  });

  it('sends the builder code header when configured', async () => {
    process.env.POLYMARKET_BUILDER_CODE = `0x${'ab'.repeat(32)}`;
    const fn = mockFetch({ address: { evm: '0xB1' } });
    await depositAddress('0xW');
    expect(fn.mock.calls[0][1].headers['X-Builder-Code']).toBe(`0x${'ab'.repeat(32)}`);
  });

  it('fails clearly when the bridge returns no evm address', async () => {
    mockFetch({ address: {} });
    await expect(depositAddress('0xW')).rejects.toMatchObject({ code: 'upstream_error' });
  });
});

describe('withdrawAddress', () => {
  it('defaults to Polygon USDC paid to the recipient', async () => {
    const fn = mockFetch({ address: { evm: '0xB2' } });
    expect(await withdrawAddress({ wallet: '0xW', recipient: '0xOMS' })).toBe('0xB2');
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({
      address: '0xW',
      toChainId: '137',
      toTokenAddress: USDC,
      recipientAddr: '0xOMS'
    });
  });
});

describe('bridgeStatus', () => {
  it('reads the status list', async () => {
    mockFetch({ transactions: [{ status: 'COMPLETED' }] });
    expect((await bridgeStatus('0xB1')).transactions[0].status).toBe('COMPLETED');
  });

  it('maps 5xx to upstream_unavailable', async () => {
    mockFetch({ error: 'down' }, 503);
    await expect(bridgeStatus('0xB1')).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: Implement it**

```ts
// Polymarket's bridge: per-wallet addresses that credit pUSD on deposit, and
// destination-bound addresses that pay out pUSD as another token on withdraw.

import { CliError } from '../errors.ts';

const BRIDGE_URL = process.env.POLYMARKET_BRIDGE_URL || 'https://bridge.polymarket.com';
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
export const BRIDGE_MIN_DEPOSIT_UNITS = 2_000_000n;

export function builderHeaders(): Record<string, string> {
  const code = process.env.POLYMARKET_BUILDER_CODE;
  return code ? { 'X-Builder-Code': code } : {};
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_URL}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...builderHeaders() },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
  } catch (err) {
    throw new CliError({ code: 'upstream_unavailable', message: `Polymarket bridge unreachable: ${(err as Error).message}`, cause: err });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new CliError({
      code: res.status >= 500 ? 'upstream_unavailable' : res.status === 429 ? 'rate_limited' : 'upstream_error',
      message: `Polymarket bridge ${path} failed (${res.status}): ${text.slice(0, 200)}`
    });
  }
  return JSON.parse(text) as T;
}

function evmOf(res: { address?: { evm?: string } }, what: string): string {
  const evm = res.address?.evm;
  if (!evm) throw new CliError({ code: 'upstream_error', message: `Polymarket bridge returned no EVM ${what} address.` });
  return evm;
}

export async function depositAddress(wallet: string): Promise<string> {
  return evmOf(await call('POST', '/deposit', { address: wallet }), 'deposit');
}

export async function withdrawAddress(params: {
  wallet: string;
  recipient: string;
  toChainId?: number;
  toToken?: string;
}): Promise<string> {
  return evmOf(
    await call('POST', '/withdraw', {
      address: params.wallet,
      toChainId: String(params.toChainId ?? 137),
      toTokenAddress: params.toToken ?? POLYGON_USDC,
      recipientAddr: params.recipient
    }),
    'withdraw'
  );
}

export async function bridgeStatus(
  address: string
): Promise<{ transactions: Array<{ status: string; [k: string]: unknown }> }> {
  const res = await call<{ transactions?: Array<{ status: string }> }>('GET', `/status/${address}`);
  return { transactions: res.transactions ?? [] };
}
```

- [ ] **Step 4: Run it and confirm it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/polymarket/bridge.ts src/lib/polymarket/bridge.test.ts
git commit -m "feat(polymarket): bridge deposit, withdraw and status client"
```

---

### Task 6: `deposit` and `withdraw` commands, plus the command scaffold

**Files:**
- Create: `src/lib/polymarket/deposits.ts`, `src/commands/polymarket/shared.ts`, `src/commands/polymarket/funds.ts`, `src/commands/polymarket/funds.test.ts`

**Interfaces:**
- Consumes: `parseUsd`, `formatUnits6` (Task 2); `requireAccount`, `getTradingClient`, `pusdBalance` (Task 3); `checkRegion`, `assertCanTrade` (Task 4); `depositAddress`, `withdrawAddress`, `bridgeStatus`, `BRIDGE_MIN_DEPOSIT_UNITS` (Task 5); `runTx` from `../../lib/tx-dispatch.ts`; `loadOmsWalletPointer` from `../../lib/storage.ts`; `tokenBalance` from `../../lib/session/live.ts`.
- Produces:
  - `shared.ts`:
    - `walletOption(y)` adds `--wallet` (default `'main'`)
    - `fail(err: unknown, opts?: { stack?: boolean }): never` prints `failureJson` or `errorJson` with `bigintReplacer` and exits 1
    - `ok(data: Record<string, unknown>): void` prints `{ ok: true, ...data }` with `bigintReplacer`
    - `omsAddress(wallet: string): Promise<string>`
  - `deposits.ts`: `type PendingDeposit = { txHash: string; amountUnits: string; bridgeAddress: string; sentAt: string }`, `loadPending(wallet)`, `savePending(wallet, d)`, `clearPending(wallet)`
  - `funds.ts`: `depositCommand`, `withdrawCommand` (yargs `CommandModule`s)

**Deposit flow** (`deposit <usd> [--wallet] [--again] [--no-wait]`):
1. `parseUsd`. Below `BRIDGE_MIN_DEPOSIT_UNITS` → `below_bridge_minimum`.
2. `requireAccount(wallet)`, `checkRegion()` → `assertCanTrade`.
3. If `loadPending(wallet)` exists and `--again` wasn't passed: call `bridgeStatus(pending.bridgeAddress)`. If any transaction is `COMPLETED`, `clearPending` and continue. Otherwise throw `bridge_pending` with `details: { txHash, sentAt }`.
4. `bridge = await depositAddress(account.wallet)`.
5. Read the OMS wallet's Polygon USDC balance with `tokenBalance`. If it's too low, throw `insufficient_balance` with hint `agent swap --to USDC --amount <usd> --broadcast`.
6. `runTx({ walletName, chainId: 137, transactions: [{ to: USDC, value: 0n, data: encodeFunctionData(erc20 transfer(bridge, units)) }], broadcast, purpose: 'trade', ref: 'polymarket-deposit' })`. On a dry run, print `{ ok, dryRun: true, from: omsAddress, bridgeAddress: bridge, polymarketWallet: account.wallet, amountUsd }` and stop.
7. `savePending(...)`, then, unless `--no-wait`, poll `pusdBalance` every 5 seconds for up to 5 minutes until it rises by at least 99% of the amount. On success: `clearPending` and print `{ ok, txHash, credited: true, pusdBalance }`. On timeout: print `{ ok: true, txHash, credited: false, hint: 'The bridge is still crediting; run agent polymarket status in a few minutes.' }`.

**Withdraw flow** (`withdraw <usd|all> [--wallet]`):
1. `requireAccount`, `checkRegion()` → `assertCanTrade`.
2. `balance = await pusdBalance(wallet)`. Amount is `balance` when `all`, otherwise `parseUsd`. Amount > balance → `insufficient_pusd`. Amount 0 → `insufficient_pusd`.
3. `recipient = await omsAddress(wallet)`, then `bridge = await withdrawAddress({ wallet: account.wallet, recipient })`.
4. On a dry run, print `{ ok, dryRun: true, amountUsd, from: account.wallet, to: recipient, via: bridge }`.
5. Broadcast: `client.transferErc20({ amount, recipientAddress: bridge, tokenAddress: PUSD })`, `await handle.wait()`, print `{ ok, txHash, amountUsd, to: recipient }`.

- [ ] **Step 1: Write `shared.ts`** (no test of its own; exercised by the command tests)

```ts
// Helpers shared by the polymarket subcommands.

import type { Argv } from 'yargs';

import { bigintReplacer, CliError, errorJson, failureJson } from '../../lib/errors.ts';
import { loadOmsWalletPointer } from '../../lib/storage.ts';

export function walletOption<T>(y: Argv<T>) {
  return y.option('wallet', { type: 'string', default: 'main', describe: 'OMS wallet name' });
}

export function ok(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ ok: true, ...data }, bigintReplacer, 2));
}

export function fail(err: unknown, { stack = false } = {}): never {
  console.error(JSON.stringify(stack ? failureJson(err) : errorJson(err), bigintReplacer));
  process.exit(1);
}

export async function omsAddress(wallet: string): Promise<string> {
  const pointer = await loadOmsWalletPointer(wallet);
  if (!pointer) {
    throw new CliError({
      code: 'not_connected',
      message: `Wallet '${wallet}' isn't connected.`,
      command: 'agent wallet login'
    });
  }
  return pointer.walletAddress;
}
```

- [ ] **Step 2: Write `deposits.ts`**

```ts
// A deposit whose transfer went out but whose pUSD hasn't been credited yet.
// Recorded so a rerun doesn't send a second deposit.

import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile, writeJsonFile } from '../session/state.ts';
import { accountDir } from './account.ts';

export type PendingDeposit = { txHash: string; amountUnits: string; bridgeAddress: string; sentAt: string };

const file = (wallet: string) => path.join(accountDir(wallet), 'pending-deposit.json');

export function loadPending(wallet: string): PendingDeposit | null {
  return (readJsonFile(file(wallet)) as PendingDeposit) ?? null;
}

export function savePending(wallet: string, d: PendingDeposit): void {
  writeJsonFile({ file: file(wallet), data: d });
}

export function clearPending(wallet: string): void {
  fs.rmSync(file(wallet), { force: true });
}
```

- [ ] **Step 3: Write the failing command test**

`src/commands/polymarket/funds.test.ts`:
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.POLYGON_AGENT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-pm-funds-'));

const m = vi.hoisted(() => ({
  runTx: vi.fn(),
  tokenBalance: vi.fn(),
  pusdBalance: vi.fn(),
  transferErc20: vi.fn(),
  depositAddress: vi.fn(async () => '0xB1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1B1'),
  withdrawAddress: vi.fn(async () => '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2'),
  bridgeStatus: vi.fn(async () => ({ transactions: [] }))
}));

vi.mock('../../lib/tx-dispatch.ts', () => ({ runTx: m.runTx }));
vi.mock('../../lib/session/live.ts', () => ({ tokenBalance: m.tokenBalance }));
vi.mock('../../lib/polymarket/region.ts', async (o) => ({
  ...(await o<typeof import('../../lib/polymarket/region.ts')>()),
  checkRegion: async () => ({ blocked: false, closeOnly: false, country: 'PT', region: null })
}));
vi.mock('../../lib/polymarket/bridge.ts', async (o) => ({
  ...(await o<typeof import('../../lib/polymarket/bridge.ts')>()),
  depositAddress: m.depositAddress,
  withdrawAddress: m.withdrawAddress,
  bridgeStatus: m.bridgeStatus
}));
vi.mock('../../lib/polymarket/account.ts', async (o) => ({
  ...(await o<typeof import('../../lib/polymarket/account.ts')>()),
  requireAccount: (w: string) => {
    if (w !== 'main') throw Object.assign(new Error('no'), { code: 'not_set_up' });
    return { kind: 'deposit-wallet', signer: '0x1', wallet: '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0', createdAt: 'x' };
  },
  pusdBalance: m.pusdBalance,
  getTradingClient: async () => ({ transferErc20: m.transferErc20 })
}));

const { depositCommand, withdrawCommand } = await import('./funds.ts');
const { saveOmsWalletPointer } = await import('../../lib/storage.ts');
const { savePending, loadPending, clearPending } = await import('../../lib/polymarket/deposits.ts');

async function run(argv: string[]) {
  const yargs = (await import('yargs')).default;
  await yargs().command(depositCommand).command(withdrawCommand).fail(false).parseAsync(argv).catch(() => undefined);
  const lines = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls]
    .map((c) => String(c[0]))
    .filter((l) => l.trimStart().startsWith('{'));
  return JSON.parse(lines.at(-1) ?? '{}');
}

beforeEach(async () => {
  await saveOmsWalletPointer('main', {
    walletAddress: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17',
    loginMethod: 'google',
    createdAt: 'x'
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  m.tokenBalance.mockResolvedValue(50_000_000n);
  m.runTx.mockResolvedValue({ walletAddress: '0xC2F4', txHash: '0xTX' });
  m.pusdBalance.mockResolvedValue(0n);
  clearPending('main');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('deposit', () => {
  it('rejects amounts under the bridge minimum before any network call', async () => {
    const out = await run(['deposit', '1.5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'below_bridge_minimum' });
    expect(m.depositAddress).not.toHaveBeenCalled();
  });

  it('rejects malformed amounts with invalid_input', async () => {
    expect(await run(['deposit', '2.0000001', '--dry-run'])).toMatchObject({ code: 'invalid_input' });
  });

  it('sends one plain USDC transfer to the bridge address through runTx', async () => {
    m.pusdBalance.mockResolvedValueOnce(0n).mockResolvedValue(5_000_000n);
    const out = await run(['deposit', '5', '--broadcast']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
    const p = m.runTx.mock.calls[0][0];
    expect(p).toMatchObject({ walletName: 'main', chainId: 137, broadcast: true, purpose: 'trade', ref: 'polymarket-deposit' });
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0].to).toBe('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359');
    expect(p.transactions[0].data.startsWith('0xa9059cbb')).toBe(true);
    expect(p.transactions[0].data.toLowerCase()).toContain('b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1');
    expect(out).toMatchObject({ ok: true, txHash: '0xTX', credited: true });
    expect(loadPending('main')).toBeNull();
  }, 20_000);

  it('does not send again while an earlier deposit is still pending', async () => {
    savePending('main', { txHash: '0xOLD', amountUnits: '5000000', bridgeAddress: '0xB1', sentAt: 'x' });
    const out = await run(['deposit', '5', '--broadcast']);
    expect(out).toMatchObject({ ok: false, code: 'bridge_pending', txHash: '0xOLD' });
    expect(m.runTx).not.toHaveBeenCalled();
  });

  it('sends again with --again', async () => {
    savePending('main', { txHash: '0xOLD', amountUnits: '5000000', bridgeAddress: '0xB1', sentAt: 'x' });
    await run(['deposit', '5', '--broadcast', '--again', '--no-wait']);
    expect(m.runTx).toHaveBeenCalledTimes(1);
  });

  it('points at a swap when the OMS wallet lacks USDC', async () => {
    m.tokenBalance.mockResolvedValue(1_000_000n);
    const out = await run(['deposit', '5', '--dry-run']);
    expect(out).toMatchObject({ ok: false, code: 'insufficient_balance' });
    expect(String(out.hint)).toMatch(/agent swap/);
  });
});

describe('withdraw', () => {
  it('withdraws everything to a bridge address paying the OMS wallet', async () => {
    m.pusdBalance.mockResolvedValue(3_250_000n);
    m.transferErc20.mockResolvedValue({ wait: async () => ({ transactionHash: '0xW' }) });
    const out = await run(['withdraw', 'all', '--broadcast']);
    expect(m.withdrawAddress).toHaveBeenCalledWith({
      wallet: '0xD0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0D0',
      recipient: '0xC2F4cAfe89AE7e1bcB86dd3f141C0a3adCEB6C17'
    });
    expect(m.transferErc20).toHaveBeenCalledWith({
      amount: 3_250_000n,
      recipientAddress: '0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2',
      tokenAddress: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'
    });
    expect(out).toMatchObject({ ok: true, txHash: '0xW', amountUsd: '3.25' });
  });

  it('refuses more than the pUSD balance', async () => {
    m.pusdBalance.mockResolvedValue(1_000_000n);
    expect(await run(['withdraw', '2', '--dry-run'])).toMatchObject({ ok: false, code: 'insufficient_pusd' });
  });

  it('refuses an empty balance for all', async () => {
    m.pusdBalance.mockResolvedValue(0n);
    expect(await run(['withdraw', 'all', '--dry-run'])).toMatchObject({ ok: false, code: 'insufficient_pusd' });
  });
});
```

- [ ] **Step 4: Run it and confirm it fails.** Run: `npx vitest run src/commands/polymarket/funds.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 5: Implement `funds.ts`**

```ts
// deposit / withdraw: move money between the OMS wallet and the Polymarket
// Deposit Wallet through Polymarket's bridge. The OMS side is a plain USDC
// transfer, so session-mode allowances cover deposits.

import type { CommandModule } from 'yargs';

import { encodeFunctionData, erc20Abi } from 'viem';

import { CliError } from '../../lib/errors.ts';
import { resolveBroadcast, withWriteFlags } from '../../lib/mode.ts';
import { getTradingClient, pusdBalance, requireAccount } from '../../lib/polymarket/account.ts';
import { formatUnits6, parseUsd } from '../../lib/polymarket/amounts.ts';
import {
  BRIDGE_MIN_DEPOSIT_UNITS,
  bridgeStatus,
  depositAddress,
  withdrawAddress
} from '../../lib/polymarket/bridge.ts';
import { clearPending, loadPending, savePending } from '../../lib/polymarket/deposits.ts';
import { PolymarketError, PUSD } from '../../lib/polymarket/gamma.ts';
import { assertCanTrade, checkRegion } from '../../lib/polymarket/region.ts';
import { tokenBalance } from '../../lib/session/live.ts';
import { runTx } from '../../lib/tx-dispatch.ts';
import { fail, ok, omsAddress, walletOption } from './shared.ts';

const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLL_MS = 5_000;
const WAIT_MS = 5 * 60_000;

type DepositArgs = { amount: string; wallet: string; again?: boolean; wait?: boolean; broadcast?: boolean; dryRun?: boolean };

async function handleDeposit(argv: DepositArgs): Promise<void> {
  try {
    const units = parseUsd(argv.amount);
    if (units < BRIDGE_MIN_DEPOSIT_UNITS) {
      throw new PolymarketError('below_bridge_minimum', `Polymarket's bridge needs at least $${formatUnits6(BRIDGE_MIN_DEPOSIT_UNITS)} per deposit.`);
    }
    const broadcast = resolveBroadcast(argv);
    const account = requireAccount(argv.wallet);
    assertCanTrade(await checkRegion());

    const pending = loadPending(argv.wallet);
    if (pending && !argv.again) {
      const { transactions } = await bridgeStatus(pending.bridgeAddress);
      if (transactions.some((t) => t.status === 'COMPLETED')) clearPending(argv.wallet);
      else {
        throw new CliError({
          code: 'bridge_pending',
          message: `An earlier deposit of $${formatUnits6(pending.amountUnits)} is still being credited.`,
          hint: 'Check agent polymarket status, or pass --again to send another deposit anyway.',
          details: { txHash: pending.txHash, sentAt: pending.sentAt }
        });
      }
    }

    const from = await omsAddress(argv.wallet);
    const held = await tokenBalance({ wallet: argv.wallet, chainId: 137, token: USDC, walletAddress: from });
    if (held < units) {
      throw new CliError({
        code: 'insufficient_balance',
        message: `Wallet '${argv.wallet}' holds $${formatUnits6(held)} USDC on Polygon; the deposit needs $${formatUnits6(units)}.`,
        hint: `agent swap --to USDC --amount ${formatUnits6(units - held)} --broadcast`
      });
    }

    const bridge = await depositAddress(account.wallet);
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [bridge as `0x${string}`, units] });
    const before = broadcast ? await pusdBalance(argv.wallet) : 0n;
    const res = await runTx({
      walletName: argv.wallet,
      chainId: 137,
      transactions: [{ to: USDC, value: 0n, data }],
      broadcast,
      purpose: 'trade',
      ref: 'polymarket-deposit'
    });
    if (!broadcast) {
      ok({ dryRun: true, from, bridgeAddress: bridge, polymarketWallet: account.wallet, amountUsd: formatUnits6(units) });
      return;
    }
    const txHash = res.txHash ?? '';
    savePending(argv.wallet, { txHash, amountUnits: units.toString(), bridgeAddress: bridge, sentAt: new Date().toISOString() });
    if (argv.wait === false) {
      ok({ txHash, credited: false, amountUsd: formatUnits6(units) });
      return;
    }
    const target = before + (units * 99n) / 100n;
    const deadline = Date.now() + WAIT_MS;
    let balance = before;
    while (Date.now() < deadline) {
      balance = await pusdBalance(argv.wallet);
      if (balance >= target) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (balance >= target) {
      clearPending(argv.wallet);
      ok({ txHash, credited: true, amountUsd: formatUnits6(units), pusdBalance: formatUnits6(balance) });
    } else {
      ok({ txHash, credited: false, amountUsd: formatUnits6(units), hint: 'The bridge is still crediting; run agent polymarket status in a few minutes.' });
    }
  } catch (err) {
    fail(err, { stack: true });
  }
}

type WithdrawArgs = { amount: string; wallet: string; broadcast?: boolean; dryRun?: boolean };

async function handleWithdraw(argv: WithdrawArgs): Promise<void> {
  try {
    const broadcast = resolveBroadcast(argv);
    const account = requireAccount(argv.wallet);
    assertCanTrade(await checkRegion());
    const balance = await pusdBalance(argv.wallet);
    const amount = String(argv.amount).toLowerCase() === 'all' ? balance : parseUsd(argv.amount);
    if (amount === 0n || amount > balance) {
      throw new PolymarketError('insufficient_pusd', `The Polymarket wallet holds $${formatUnits6(balance)} pUSD.`);
    }
    const recipient = await omsAddress(argv.wallet);
    const bridge = await withdrawAddress({ wallet: account.wallet, recipient });
    if (!broadcast) {
      ok({ dryRun: true, amountUsd: formatUnits6(amount), from: account.wallet, to: recipient, via: bridge });
      return;
    }
    const client = await getTradingClient(argv.wallet);
    const handle = await client.transferErc20({ amount, recipientAddress: bridge, tokenAddress: PUSD });
    const outcome = await handle.wait();
    ok({ txHash: outcome.transactionHash, amountUsd: formatUnits6(amount), to: recipient });
  } catch (err) {
    fail(err, { stack: true });
  }
}

export const depositCommand: CommandModule = {
  command: 'deposit <amount>',
  describe: 'Move USDC from the OMS wallet into the Polymarket account (min $2)',
  builder: (y) =>
    withWriteFlags(
      walletOption(y)
        .positional('amount', { type: 'string', demandOption: true, describe: 'USD amount' })
        .option('again', { type: 'boolean', default: false, describe: 'Send even if an earlier deposit is still pending' })
        .option('wait', { type: 'boolean', default: true, describe: 'Wait for the bridge to credit pUSD (--no-wait to skip)' })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleDeposit(argv as any)
};

export const withdrawCommand: CommandModule = {
  command: 'withdraw <amount>',
  describe: 'Move pUSD from the Polymarket account back to the OMS wallet as USDC',
  builder: (y) =>
    withWriteFlags(
      walletOption(y).positional('amount', { type: 'string', demandOption: true, describe: "USD amount or 'all'" })
    ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (argv) => handleWithdraw(argv as any)
};
```

If `PUSD` isn't exported from `gamma.ts` after the move, it is: `export const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB'`. The deposit test's 20-second timeout covers one 5-second poll; mock `pusdBalance` so the second read already shows the credit.

- [ ] **Step 6: Run the tests and confirm they pass.** Run: `npx vitest run src/commands/polymarket/funds.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/polymarket/deposits.ts src/commands/polymarket/shared.ts src/commands/polymarket/funds.ts src/commands/polymarket/funds.test.ts
git commit -m "feat(polymarket): deposit and withdraw through Polymarket's bridge"
```

---

### Task 7: Market and outcome resolution, plus discovery commands

**Files:**
- Create: `src/lib/polymarket/resolve.ts`, `src/lib/polymarket/resolve.test.ts`, `src/commands/polymarket/discover.ts`, `src/commands/polymarket/discover.test.ts`

**Interfaces:**
- Consumes: `loadSdk`, `mapSdkError` (Task 1).
- Produces:
  - `type ResolvedOutcome = { market: SdkMarket; outcome: 'yes' | 'no'; label: string; assetId: string; price: string | null }`
  - `resolveOutcome(ref: string, outcome: string): Promise<ResolvedOutcome>`
  - `publicClient(): Promise<PublicClient>`
  - `summarizeMarket(m: SdkMarket): Record<string, unknown>`, a compact JSON for agents: `{ id, slug, conditionId, question, version, negRisk, acceptingOrders, closed, endDate, outcomes: { yes: {label, price, assetId}, no: {...} }, bestBid, bestAsk, spread, volume24hr }`

**Resolution rules:**
1. `ref` starting with `0x` and 66 characters long is a conditionId: `listMarkets({ conditionIds: [ref] }).firstPage()`; with no items, retry with `closed: true`.
2. Otherwise try `fetchMarket({ slug: ref })`. On a 404, try `fetchEvent({ slug: ref })`.
3. A single market: `outcome` matches `yes`/`no` case-insensitively, or the outcome labels.
4. An event: `outcome` matches a market's `groupItemTitle` case-insensitively (exact match first, then a unique substring), and the YES side of that market is used. `outcome` may also be `"<name> no"` to take the NO side. No match → `outcome_not_found` with `details.choices` (the titles). More than one substring match → `ambiguous_market`.
5. `assetId = market.version === 'v2' ? positionId : tokenId`. A missing asset id → `outcome_not_found`.

**Discovery commands:**
- `event <slug>`: `{ event: { id, slug, title, endDate, negRisk }, markets: summarizeMarket[] }`, open markets only unless `--all`.
- `market <ref>`: `summarizeMarket` of the resolved market. With the event fallback, it lists the event's markets like `event` does.
- `book <ref> <outcome> [--depth 10]`: `{ assetId, bestBid, bestAsk, spread, bids: top N (best first), asks: top N (best first), minOrderSize, tickSize }`. Remember the SDK returns both sides best-**last**, so reverse them.
- `history <ref> <outcome> [--interval 1d|1w|1m|6h|1h|max] [--points 60]`: downsample the first page to at most `--points` points: `{ interval, points: [{ t: iso, price }] }`.
- `markets` stays on the Gamma code from #145 (moved into `discover.ts` unchanged).

- [ ] **Step 1: Write the failing resolver test** (the SDK is mocked)

```ts
import { describe, expect, it, vi } from 'vitest';

const market = (over: Record<string, unknown> = {}) => ({
  id: '1', slug: 'will-x', conditionId: `0x${'a'.repeat(64)}`, question: 'Will X?', version: 'v1', groupItemTitle: null,
  state: { acceptingOrders: true, closed: false, negRisk: false },
  outcomes: {
    yes: { label: 'Yes', tokenId: 'T-YES', positionId: 'P-YES', price: '0.4' },
    no: { label: 'No', tokenId: 'T-NO', positionId: 'P-NO', price: '0.6' }
  },
  prices: {}, metrics: {}, ...over
});

const pub = vi.hoisted(() => ({
  listMarkets: vi.fn(),
  fetchMarket: vi.fn(),
  fetchEvent: vi.fn()
}));

vi.mock('./sdk.ts', async (o) => ({
  ...(await o<typeof import('./sdk.ts')>()),
  loadSdk: async () => ({
    root: {
      createPublicClient: () => pub,
      RequestRejectedError: class extends Error { status = 404; }
    }
  })
}));

const { resolveOutcome } = await import('./resolve.ts');
const { loadSdk } = await import('./sdk.ts');

describe('resolveOutcome', () => {
  it('resolves a conditionId and a yes/no outcome to the v1 token id', async () => {
    pub.listMarkets.mockReturnValue({ firstPage: async () => ({ items: [market()] }) });
    const r = await resolveOutcome(`0x${'a'.repeat(64)}`, 'yes');
    expect(r).toMatchObject({ outcome: 'yes', assetId: 'T-YES', price: '0.4' });
  });

  it('uses positionId for v2 markets', async () => {
    pub.fetchMarket.mockResolvedValue(market({ version: 'v2' }));
    expect((await resolveOutcome('will-x', 'No')).assetId).toBe('P-NO');
  });

  it('resolves an event slug and a candidate name to that market\'s YES side', async () => {
    const { root } = await loadSdk();
    pub.fetchMarket.mockRejectedValue(new (root.RequestRejectedError as never as new () => Error)());
    pub.fetchEvent.mockResolvedValue({
      slug: 'election',
      markets: [
        market({ id: '1', groupItemTitle: 'Alice', outcomes: { yes: { label: 'Yes', tokenId: 'A-Y', price: '0.3' }, no: { label: 'No', tokenId: 'A-N', price: '0.7' } } }),
        market({ id: '2', groupItemTitle: 'Bob', outcomes: { yes: { label: 'Yes', tokenId: 'B-Y', price: '0.6' }, no: { label: 'No', tokenId: 'B-N', price: '0.4' } } })
      ]
    });
    expect((await resolveOutcome('election', 'bob')).assetId).toBe('B-Y');
    expect((await resolveOutcome('election', 'bob no')).assetId).toBe('B-N');
  });

  it('lists the choices when the outcome is unknown', async () => {
    pub.fetchMarket.mockResolvedValue(market());
    await expect(resolveOutcome('will-x', 'maybe')).rejects.toMatchObject({
      code: 'outcome_not_found',
      details: { choices: ['Yes', 'No'] }
    });
  });

  it('refuses an ambiguous partial match', async () => {
    const { root } = await loadSdk();
    pub.fetchMarket.mockRejectedValue(new (root.RequestRejectedError as never as new () => Error)());
    pub.fetchEvent.mockResolvedValue({
      slug: 'e',
      markets: [market({ groupItemTitle: 'John Smith' }), market({ id: '2', groupItemTitle: 'John Doe' })]
    });
    await expect(resolveOutcome('e', 'john')).rejects.toMatchObject({ code: 'ambiguous_market' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `resolve.ts`**

```ts
// Turn what an agent types (a conditionId, a market slug, or an event slug plus
// an outcome name) into the exact market side and CLOB asset id to trade.

import { CliError } from '../errors.ts';
import { PolymarketError } from './gamma.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SdkMarket = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PublicClient = any;

export type ResolvedOutcome = {
  market: SdkMarket;
  outcome: 'yes' | 'no';
  label: string;
  assetId: string;
  price: string | null;
};

let pub: PublicClient | undefined;
export async function publicClient(): Promise<PublicClient> {
  if (!pub) pub = (await loadSdk()).root.createPublicClient();
  return pub;
}

const isConditionId = (ref: string) => /^0x[0-9a-fA-F]{64}$/.test(ref);

async function byConditionId(ref: string): Promise<SdkMarket | null> {
  const c = await publicClient();
  for (const closed of [undefined, true]) {
    const page = await c.listMarkets({ conditionIds: [ref], ...(closed ? { closed } : {}) }).firstPage();
    if (page.items.length) return page.items[0];
  }
  return null;
}

async function bySlug(ref: string): Promise<{ market?: SdkMarket; event?: { slug: string; markets: SdkMarket[] } }> {
  const c = await publicClient();
  const { root } = await loadSdk();
  try {
    return { market: await c.fetchMarket({ slug: ref }) };
  } catch (err) {
    if (!(err instanceof root.RequestRejectedError)) throw mapSdkError(err);
  }
  try {
    return { event: await c.fetchEvent({ slug: ref }) };
  } catch (err) {
    if (err instanceof root.RequestRejectedError) return {};
    throw mapSdkError(err);
  }
}

function side(market: SdkMarket, outcome: 'yes' | 'no'): ResolvedOutcome {
  const o = market.outcomes?.[outcome];
  const assetId = market.version === 'v2' ? o?.positionId : o?.tokenId;
  if (!assetId) {
    throw new PolymarketError('outcome_not_found', `Market ${market.slug ?? market.id} has no tradable ${outcome} side.`);
  }
  return { market, outcome, label: o.label, assetId, price: o.price ?? null };
}

function pickSide(market: SdkMarket, name: string): ResolvedOutcome {
  const n = name.trim().toLowerCase();
  for (const key of ['yes', 'no'] as const) {
    if (n === key || n === String(market.outcomes?.[key]?.label ?? '').toLowerCase()) return side(market, key);
  }
  throw new CliError({
    code: 'outcome_not_found',
    message: `'${name}' isn't an outcome of this market.`,
    details: { choices: [market.outcomes?.yes?.label, market.outcomes?.no?.label].filter(Boolean) }
  });
}

function pickFromEvent(event: { slug: string; markets: SdkMarket[] }, name: string): ResolvedOutcome {
  let n = name.trim().toLowerCase();
  let outcome: 'yes' | 'no' = 'yes';
  const m = n.match(/^(.*)\s+(yes|no)$/);
  if (m) {
    n = m[1];
    outcome = m[2] as 'yes' | 'no';
  }
  const titled = event.markets.filter((x) => x.groupItemTitle);
  const exact = titled.filter((x) => String(x.groupItemTitle).toLowerCase() === n);
  const partial = exact.length ? exact : titled.filter((x) => String(x.groupItemTitle).toLowerCase().includes(n));
  if (partial.length === 1) return side(partial[0], outcome);
  const choices = titled.map((x) => x.groupItemTitle);
  if (partial.length > 1) {
    throw new CliError({
      code: 'ambiguous_market',
      message: `'${name}' matches several outcomes in ${event.slug}.`,
      details: { choices: partial.map((x) => x.groupItemTitle) }
    });
  }
  throw new CliError({ code: 'outcome_not_found', message: `'${name}' isn't an outcome of ${event.slug}.`, details: { choices } });
}

export async function resolveOutcome(ref: string, outcome: string): Promise<ResolvedOutcome> {
  if (isConditionId(ref)) {
    const market = await byConditionId(ref);
    if (!market) throw new PolymarketError('outcome_not_found', `No market with condition id ${ref}.`);
    return pickSide(market, outcome);
  }
  const found = await bySlug(ref);
  if (found.market) return pickSide(found.market, outcome);
  if (found.event) return pickFromEvent(found.event, outcome);
  throw new PolymarketError('outcome_not_found', `No market or event with slug '${ref}'.`);
}

export function summarizeMarket(m: SdkMarket): Record<string, unknown> {
  const out = (k: 'yes' | 'no') => {
    const o = m.outcomes?.[k] ?? {};
    return { label: o.label, price: o.price ?? null, assetId: m.version === 'v2' ? o.positionId : o.tokenId };
  };
  return {
    id: m.id,
    slug: m.slug,
    conditionId: m.conditionId,
    question: m.question,
    title: m.groupItemTitle ?? undefined,
    version: m.version,
    negRisk: !!m.state?.negRisk,
    acceptingOrders: !!m.state?.acceptingOrders,
    closed: !!m.state?.closed,
    endDate: m.state?.endDate ?? null,
    outcomes: { yes: out('yes'), no: out('no') },
    bestBid: m.prices?.bestBid ?? null,
    bestAsk: m.prices?.bestAsk ?? null,
    spread: m.prices?.spread ?? null,
    volume24hr: m.metrics?.volume24hr ?? null
  };
}
```

- [ ] **Step 4: Run it and confirm it passes.** Expected: PASS.

- [ ] **Step 5: Write the failing discovery command test**

`src/commands/polymarket/discover.test.ts`: mock `../../lib/polymarket/resolve.ts` (`resolveOutcome`, `publicClient`) and assert:
```ts
it('book returns best-first sides', async () => {
  resolved.mockResolvedValue({ assetId: 'T', market: {}, outcome: 'yes', label: 'Yes', price: '0.5' });
  client.fetchOrderBook.mockResolvedValue({
    bids: [{ price: '0.1', size: '1' }, { price: '0.4', size: '2' }],
    asks: [{ price: '0.9', size: '1' }, { price: '0.5', size: '3' }],
    minOrderSize: '5', tickSize: 0.01
  });
  const out = await run(['book', 'will-x', 'yes', '--depth', '1']);
  expect(out).toMatchObject({ ok: true, bestBid: '0.4', bestAsk: '0.5', spread: '0.1', bids: [{ price: '0.4', size: '2' }], asks: [{ price: '0.5', size: '3' }] });
});

it('history downsamples to --points', async () => {
  resolved.mockResolvedValue({ assetId: 'T', market: {}, outcome: 'yes', label: 'Yes', price: '0.5' });
  const items = Array.from({ length: 100 }, (_, i) => ({ timestamp: 1_700_000_000_000 + i * 60_000, price: String(i / 100) }));
  client.listPriceHistory.mockReturnValue({ firstPage: async () => ({ items }) });
  const out = await run(['history', 'will-x', 'yes', '--points', '10']);
  expect(out.points).toHaveLength(10);
  expect(out.points.at(-1).price).toBe('0.99');
});

it('event lists open markets only by default', async () => {
  client.fetchEvent.mockResolvedValue({ id: 'e', slug: 'e', title: 'E', markets: [
    { id: '1', state: { closed: false, acceptingOrders: true }, outcomes: {} },
    { id: '2', state: { closed: true }, outcomes: {} }
  ] });
  const out = await run(['event', 'e']);
  expect(out.markets.map((m: { id: string }) => m.id)).toEqual(['1']);
});
```
Use the same `run` helper shape as Task 6, with `const client = { fetchOrderBook: vi.fn(), listPriceHistory: vi.fn(), fetchEvent: vi.fn() }` returned by the mocked `publicClient`.

- [ ] **Step 6: Implement `discover.ts`**

Move the `markets` builder and handler from the old `src/commands/polymarket.ts` unchanged (it uses `getMarkets` from `gamma.ts`). Add these:

```ts
import type { CommandModule } from 'yargs';

import { getMarkets, PolymarketError } from '../../lib/polymarket/gamma.ts';
import { publicClient, resolveOutcome, summarizeMarket } from '../../lib/polymarket/resolve.ts';
import { loadSdk, mapSdkError } from '../../lib/polymarket/sdk.ts';
import { fail, ok } from './shared.ts';

const INTERVALS = ['1h', '6h', '1d', '1w', '1m', 'max'] as const;

async function handleEvent(argv: { slug: string; all?: boolean }) {
  try {
    const c = await publicClient();
    const ev = await c.fetchEvent({ slug: argv.slug }).catch((e: unknown) => { throw mapSdkError(e); });
    const markets = (ev.markets ?? []).filter((m: { state?: { closed?: boolean } }) => argv.all || !m.state?.closed);
    ok({ event: { id: ev.id, slug: ev.slug, title: ev.title, endDate: ev.schedule?.endDate ?? null, negRisk: !!ev.trading?.negRisk }, count: markets.length, markets: markets.map(summarizeMarket) });
  } catch (err) { fail(err); }
}

async function handleMarket(argv: { ref: string }) {
  try {
    const r = await resolveOutcome(argv.ref, 'yes');
    ok({ market: summarizeMarket(r.market) });
  } catch (err) {
    // An event slug with several markets: show the event instead.
    if ((err as { code?: string }).code === 'outcome_not_found' && !/^0x/.test(argv.ref)) return handleEvent({ slug: argv.ref });
    fail(err);
  }
}

async function handleBook(argv: { ref: string; outcome: string; depth: number }) {
  try {
    const r = await resolveOutcome(argv.ref, argv.outcome);
    const c = await publicClient();
    const book = await c.fetchOrderBook({ assetId: r.assetId }).catch((e: unknown) => { throw mapSdkError(e); });
    const bids = [...book.bids].reverse().slice(0, argv.depth);
    const asks = [...book.asks].reverse().slice(0, argv.depth);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const spread = bestBid && bestAsk ? String(Math.round((Number(bestAsk) - Number(bestBid)) * 1e6) / 1e6) : null;
    ok({ market: r.market.slug, outcome: r.label, assetId: r.assetId, bestBid, bestAsk, spread, bids, asks, minOrderSize: book.minOrderSize, tickSize: book.tickSize });
  } catch (err) { fail(err); }
}

async function handleHistory(argv: { ref: string; outcome: string; interval: (typeof INTERVALS)[number]; points: number }) {
  try {
    const r = await resolveOutcome(argv.ref, argv.outcome);
    const c = await publicClient();
    const page = await c.listPriceHistory({ assetId: r.assetId, interval: argv.interval }).firstPage().catch((e: unknown) => { throw mapSdkError(e); });
    const items = page.items as Array<{ timestamp: number; price: string }>;
    const step = Math.max(1, Math.ceil(items.length / argv.points));
    const sampled = items.filter((_, i) => i % step === 0 || i === items.length - 1).slice(-argv.points);
    ok({ market: r.market.slug, outcome: r.label, interval: argv.interval, points: sampled.map((p) => ({ t: new Date(p.timestamp).toISOString(), price: p.price })) });
  } catch (err) { fail(err); }
}
```
In the test, make sure `slice(-points)` keeps the last point. Export `marketsCommand`, `eventCommand`, `marketCommand`, `bookCommand` and `historyCommand` as `CommandModule`s:
- `event <slug>` with `--all`
- `market <ref>`
- `book <ref> <outcome>` with `--depth` (number, default 10)
- `history <ref> <outcome>` with `--interval` (choices `INTERVALS`, default `'1d'`) and `--points` (number, default 60)

Remove the unused imports (`loadSdk`, `PolymarketError`) if lint flags them.

- [ ] **Step 7: Run the tests.** Run: `npx vitest run src/lib/polymarket/resolve.test.ts src/commands/polymarket/discover.test.ts`. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/polymarket/resolve.ts src/lib/polymarket/resolve.test.ts src/commands/polymarket/discover.ts src/commands/polymarket/discover.test.ts
git commit -m "feat(polymarket): resolve markets by slug and outcome name; event, book, history"
```

---

### Task 8: Orders: buy, sell, orders, cancel

**Files:**
- Create: `src/lib/polymarket/orders.ts`, `src/lib/polymarket/orders.test.ts`, `src/commands/polymarket/trade.ts`, `src/commands/polymarket/trade.test.ts`

**Interfaces:**
- Consumes: `getTradingClient` (Task 3); `checkRegion`, `assertCanOpen`, `assertCanTrade` (Task 4); `resolveOutcome` (Task 7); `parseUsd`, `parseShares` (Task 2); `loadSdk`, `mapSdkError` (Task 1).
- Produces:
  - `type BuyRequest = { wallet: string; ref: string; outcome: string; usd: string; maxPrice?: number; limitPrice?: number; expiresMinutes?: number; broadcast: boolean }`
  - `type SellRequest = { wallet: string; ref: string; outcome: string; shares: string; minPrice?: number; limitPrice?: number; expiresMinutes?: number; broadcast: boolean }`
  - `buy(req: BuyRequest): Promise<Record<string, unknown>>`
  - `sell(req: SellRequest): Promise<Record<string, unknown>>`
  - `normalizeOrderResponse(res: OrderResponse): Record<string, unknown>` (throws `order_rejected` for `ok: false`)

**Rules:**
- **Buy:**
  - `assertCanOpen(await checkRegion(client))`.
  - Market buy: `est = client.estimateMarketPrice({ assetId, side: BUY, amount: usd })`. If `maxPrice` is set and `est > maxPrice` → `price_guard` with `details: { estimatedPrice: est, maxPrice }`, and nothing is posted.
  - Dry run: return `{ dryRun: true, market, outcome, assetId, amountUsd, estimatedPrice, estimatedShares: usd/est, orderType: 'market'|'limit' }`.
  - Broadcast: `client.placeMarketOrder({ assetId, side: BUY, amount: usd, ...(maxPrice ? { maxPrice } : {}), ...builderCode, orderType: FAK })`.
  - Limit buy (`limitPrice`): `size = usd / limitPrice`, rounded down to 2 decimals, then `placeLimitOrder({ assetId, side: BUY, price: limitPrice, size, expiration? })`. `expiration = now_seconds + expiresMinutes*60`, which must be at least 3 minutes (else `invalid_input`).
  - The pUSD balance is checked first: less than the amount → `insufficient_pusd` with hint `agent polymarket deposit <usd> --broadcast`.
- **Sell:**
  - `assertCanTrade` (selling is allowed in close-only regions).
  - Shares held come from `client.listPositions({ conditionId: market.conditionId }).firstPage()`: find the item with `assetId === assetId` (or `tokenId`) and use its `currentSize`.
  - `all` → `currentSize`. Held 0, or requested more than held → `insufficient_shares`.
  - Market: `estimateMarketPrice({ side: SELL, shares })`. If `minPrice` is set and `est < minPrice` → `price_guard`.
  - Broadcast: `placeMarketOrder({ assetId, side: SELL, shares, minPrice?, orderType: FAK })`. Limit: `placeLimitOrder({ side: SELL, price, size: shares, expiration? })`.
- `builderCode` is included only when `POLYMARKET_BUILDER_CODE` is set.
- `normalizeOrderResponse`:
  - `{ ok: true }` → `{ orderId, status, filledUsd: makingAmount or takingAmount by side, filledShares, txHashes: transactionsHashes }`
  - `{ ok: false, code, message }` → throw `CliError('order_rejected', message, details: { venueCode: code })`

- [ ] **Step 1: Write the failing `orders.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  estimateMarketPrice: vi.fn(),
  placeMarketOrder: vi.fn(),
  placeLimitOrder: vi.fn(),
  listPositions: vi.fn(),
  fetchClosedOnlyMode: vi.fn(async () => false)
}));
const region = vi.hoisted(() => ({ value: { blocked: false, closeOnly: false, country: 'PT', region: null } }));

vi.mock('./account.ts', () => ({
  getTradingClient: async () => client,
  pusdBalance: async () => 50_000_000n
}));
vi.mock('./region.ts', async (o) => ({ ...(await o<typeof import('./region.ts')>()), checkRegion: async () => region.value }));
vi.mock('./resolve.ts', () => ({
  resolveOutcome: async () => ({
    market: { slug: 'will-x', conditionId: '0xc' }, outcome: 'yes', label: 'Yes', assetId: 'T-YES', price: '0.4'
  })
}));
vi.mock('./sdk.ts', async (o) => ({
  ...(await o<typeof import('./sdk.ts')>()),
  loadSdk: async () => ({ root: { OrderSide: { BUY: 'BUY', SELL: 'SELL' }, OrderType: { FAK: 'FAK' } } })
}));

const { buy, sell } = await import('./orders.ts');

beforeEach(() => {
  vi.clearAllMocks();
  region.value = { blocked: false, closeOnly: false, country: 'PT', region: null };
});

describe('buy', () => {
  it('refuses when the estimated fill is worse than --max-price and posts nothing', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.62);
    await expect(
      buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', maxPrice: 0.55, broadcast: true })
    ).rejects.toMatchObject({ code: 'price_guard', details: { estimatedPrice: 0.62, maxPrice: 0.55 } });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('passes maxPrice to the venue when the estimate is within it', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue({ ok: true, orderId: 'o1', status: 'matched', makingAmount: '5', takingAmount: '10', transactionsHashes: [], tradeIds: [] });
    const out = await buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', maxPrice: 0.55, broadcast: true });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'T-YES', side: 'BUY', amount: '5', maxPrice: 0.55, orderType: 'FAK' }));
    expect(out).toMatchObject({ orderId: 'o1', status: 'matched' });
  });

  it('is refused in a close-only region', async () => {
    region.value = { ...region.value, closeOnly: true };
    await expect(buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: false })).rejects.toMatchObject({ code: 'region_close_only' });
  });

  it('turns a venue rejection into order_rejected', async () => {
    client.estimateMarketPrice.mockResolvedValue(0.5);
    client.placeMarketOrder.mockResolvedValue({ ok: false, code: 'fak_not_filled', message: 'no liquidity' });
    await expect(buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', broadcast: true })).rejects.toMatchObject({ code: 'order_rejected', details: { venueCode: 'fak_not_filled' } });
  });

  it('places a limit buy sized in shares', async () => {
    client.placeLimitOrder.mockResolvedValue({ ok: true, orderId: 'o2', status: 'live', makingAmount: '0', takingAmount: '0', transactionsHashes: [], tradeIds: [] });
    await buy({ wallet: 'main', ref: 'will-x', outcome: 'yes', usd: '5', limitPrice: 0.3, broadcast: true });
    expect(client.placeLimitOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY', price: 0.3, size: 16.66 }));
  });
});

describe('sell', () => {
  it('sells all held shares', async () => {
    client.listPositions.mockReturnValue({ firstPage: async () => ({ items: [{ assetId: 'T-YES', currentSize: '12.5' }] }) });
    client.estimateMarketPrice.mockResolvedValue(0.39);
    client.placeMarketOrder.mockResolvedValue({ ok: true, orderId: 'o3', status: 'matched', makingAmount: '12.5', takingAmount: '4.87', transactionsHashes: [], tradeIds: [] });
    await sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: 'all', broadcast: true });
    expect(client.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'SELL', shares: 12.5 }));
  });

  it('refuses all with no position, posting nothing', async () => {
    client.listPositions.mockReturnValue({ firstPage: async () => ({ items: [] }) });
    await expect(sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: 'all', broadcast: true })).rejects.toMatchObject({ code: 'insufficient_shares' });
    expect(client.placeMarketOrder).not.toHaveBeenCalled();
  });

  it('still works in a close-only region', async () => {
    region.value = { ...region.value, closeOnly: true };
    client.listPositions.mockReturnValue({ firstPage: async () => ({ items: [{ assetId: 'T-YES', currentSize: '3' }] }) });
    client.estimateMarketPrice.mockResolvedValue(0.4);
    await expect(sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: '3', broadcast: false })).resolves.toMatchObject({ dryRun: true });
  });

  it('refuses a min-price breach', async () => {
    client.listPositions.mockReturnValue({ firstPage: async () => ({ items: [{ assetId: 'T-YES', currentSize: '3' }] }) });
    client.estimateMarketPrice.mockResolvedValue(0.2);
    await expect(sell({ wallet: 'main', ref: 'will-x', outcome: 'yes', shares: '3', minPrice: 0.3, broadcast: true })).rejects.toMatchObject({ code: 'price_guard' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `orders.ts`**

```ts
// Buying and selling outcome shares on the trading account, with a worst-price
// guard checked before anything is posted.

import { CliError } from '../errors.ts';
import { getTradingClient, pusdBalance } from './account.ts';
import { formatUnits6, parseShares, parseUsd } from './amounts.ts';
import { PolymarketError } from './gamma.ts';
import { assertCanOpen, assertCanTrade, checkRegion } from './region.ts';
import { resolveOutcome } from './resolve.ts';
import { loadSdk, mapSdkError } from './sdk.ts';

export type BuyRequest = { wallet: string; ref: string; outcome: string; usd: string; maxPrice?: number; limitPrice?: number; expiresMinutes?: number; broadcast: boolean };
export type SellRequest = { wallet: string; ref: string; outcome: string; shares: string; minPrice?: number; limitPrice?: number; expiresMinutes?: number; broadcast: boolean };

const builder = () => (process.env.POLYMARKET_BUILDER_CODE ? { builderCode: process.env.POLYMARKET_BUILDER_CODE } : {});

function expiration(minutes?: number): { expiration?: number } {
  if (minutes === undefined) return {};
  if (minutes < 3) throw new CliError({ code: 'invalid_input', message: '--expires must be at least 3 minutes.' });
  return { expiration: Math.floor(Date.now() / 1000) + Math.round(minutes * 60) };
}

function checkPrice(name: string, p?: number): void {
  if (p !== undefined && !(p > 0 && p < 1)) throw new CliError({ code: 'invalid_input', message: `${name} must be between 0 and 1.` });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeOrderResponse(res: any, side: 'BUY' | 'SELL'): Record<string, unknown> {
  if (!res?.ok) {
    throw new CliError({ code: 'order_rejected', message: res?.message ?? 'Order rejected', details: { venueCode: res?.code } });
  }
  return {
    orderId: res.orderId,
    status: res.status,
    filledUsd: side === 'BUY' ? res.makingAmount : res.takingAmount,
    filledShares: side === 'BUY' ? res.takingAmount : res.makingAmount,
    txHashes: res.transactionsHashes ?? []
  };
}

export async function buy(req: BuyRequest): Promise<Record<string, unknown>> {
  checkPrice('--max-price', req.maxPrice);
  checkPrice('--price', req.limitPrice);
  const units = parseUsd(req.usd);
  const usd = formatUnits6(units);
  const client = await getTradingClient(req.wallet);
  const { root } = await loadSdk();
  try {
    assertCanOpen(await checkRegion(client));
    const r = await resolveOutcome(req.ref, req.outcome);
    const held = await pusdBalance(req.wallet);
    if (held < units) {
      throw new CliError({
        code: 'insufficient_pusd',
        message: `The Polymarket wallet holds $${formatUnits6(held)} pUSD.`,
        hint: `agent polymarket deposit ${formatUnits6(units - held < 2_000_000n ? 2_000_000n : units - held)} --wallet ${req.wallet} --broadcast`
      });
    }
    const base = { market: r.market.slug, outcome: r.label, assetId: r.assetId, amountUsd: usd };
    if (req.limitPrice !== undefined) {
      const size = Math.floor((Number(usd) / req.limitPrice) * 100) / 100;
      const order = { assetId: r.assetId, side: root.OrderSide.BUY, price: req.limitPrice, size, ...expiration(req.expiresMinutes), ...builder() };
      if (!req.broadcast) return { dryRun: true, ...base, orderType: 'limit', price: req.limitPrice, size };
      return { ...base, ...normalizeOrderResponse(await client.placeLimitOrder(order), 'BUY') };
    }
    const est = await client.estimateMarketPrice({ assetId: r.assetId, side: root.OrderSide.BUY, amount: usd });
    if (req.maxPrice !== undefined && est > req.maxPrice) {
      throw new CliError({ code: 'price_guard', message: `The estimated fill price ${est} is worse than --max-price ${req.maxPrice}.`, details: { estimatedPrice: est, maxPrice: req.maxPrice } });
    }
    if (!req.broadcast) return { dryRun: true, ...base, orderType: 'market', estimatedPrice: est, estimatedShares: Math.floor((Number(usd) / est) * 100) / 100 };
    const res = await client.placeMarketOrder({
      assetId: r.assetId, side: root.OrderSide.BUY, amount: usd,
      ...(req.maxPrice !== undefined ? { maxPrice: req.maxPrice } : {}), orderType: root.OrderType.FAK, ...builder()
    });
    return { ...base, estimatedPrice: est, ...normalizeOrderResponse(res, 'BUY') };
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function sell(req: SellRequest): Promise<Record<string, unknown>> {
  checkPrice('--min-price', req.minPrice);
  checkPrice('--price', req.limitPrice);
  const wanted = parseShares(req.shares);
  const client = await getTradingClient(req.wallet);
  const { root } = await loadSdk();
  try {
    assertCanTrade(await checkRegion(client));
    const r = await resolveOutcome(req.ref, req.outcome);
    const page = await client.listPositions({ conditionId: r.market.conditionId }).firstPage();
    const pos = (page.items as Array<{ assetId?: string; tokenId?: string; currentSize?: string }>).find(
      (p) => p.assetId === r.assetId || p.tokenId === r.assetId
    );
    const heldShares = Number(pos?.currentSize ?? 0);
    const shares = wanted === 'all' ? heldShares : wanted;
    if (heldShares <= 0 || shares > heldShares) {
      throw new PolymarketError('insufficient_shares', `Holding ${heldShares} ${r.label} shares in ${r.market.slug}.`);
    }
    const base = { market: r.market.slug, outcome: r.label, assetId: r.assetId, shares };
    if (req.limitPrice !== undefined) {
      const order = { assetId: r.assetId, side: root.OrderSide.SELL, price: req.limitPrice, size: shares, ...expiration(req.expiresMinutes), ...builder() };
      if (!req.broadcast) return { dryRun: true, ...base, orderType: 'limit', price: req.limitPrice };
      return { ...base, ...normalizeOrderResponse(await client.placeLimitOrder(order), 'SELL') };
    }
    const est = await client.estimateMarketPrice({ assetId: r.assetId, side: root.OrderSide.SELL, shares });
    if (req.minPrice !== undefined && est < req.minPrice) {
      throw new CliError({ code: 'price_guard', message: `The estimated fill price ${est} is worse than --min-price ${req.minPrice}.`, details: { estimatedPrice: est, minPrice: req.minPrice } });
    }
    if (!req.broadcast) return { dryRun: true, ...base, orderType: 'market', estimatedPrice: est, estimatedUsd: Math.floor(shares * est * 100) / 100 };
    const res = await client.placeMarketOrder({
      assetId: r.assetId, side: root.OrderSide.SELL, shares,
      ...(req.minPrice !== undefined ? { minPrice: req.minPrice } : {}), orderType: root.OrderType.FAK, ...builder()
    });
    return { ...base, estimatedPrice: est, ...normalizeOrderResponse(res, 'SELL') };
  } catch (err) {
    throw mapSdkError(err);
  }
}
```

- [ ] **Step 4: Run it and confirm it passes.** Run: `npx vitest run src/lib/polymarket/orders.test.ts`. Expected: PASS.

- [ ] **Step 5: Write `trade.ts` and its test**

Commands:
- `buy <ref> <outcome> <usd>`: `withWriteFlags` + `walletOption` + `--max-price` (number) + `--price` (number, limit) + `--expires` (number, minutes). It calls `buy({ ..., broadcast: resolveBroadcast(argv) })` and prints `ok(result)`.
- `sell <ref> <outcome> <shares>`: `--min-price`, `--price`, `--expires`.
- `orders [--market <ref>]`: `client.listOpenOrders(market ? { market: conditionId } : {}).firstPage()`, printing `{ count, orders: items.map(o => ({ id, market: o.conditionId, outcome: o.outcome, side, price, size: o.originalSize, filled: o.sizeMatched, expiresAt })) }`. A market given by slug is resolved through `resolveOutcome(ref, 'yes')` to get its `conditionId`.
- `cancel [orderId] [--all] [--market <ref>]`, which is a write:
  - Exactly one of `orderId`, `--all` or `--market` is allowed, else `invalid_input`.
  - Dry run lists what would be cancelled (via `listOpenOrders`).
  - Broadcast calls `cancelOrder({orderId})` / `cancelAll()` / `cancelMarketOrders({ market: conditionId })` and prints `{ canceled, notCanceled }`.

`trade.test.ts` checks that:
- `cancel` with nothing passed fails `invalid_input`;
- `cancel --all --broadcast` calls `cancelAll` once;
- `buy ... --dry-run` passes `broadcast: false` to the mocked `buy`. Mock `../../lib/polymarket/orders.ts` and `../../lib/polymarket/account.ts` (`getTradingClient` returns `{ cancelAll, cancelOrder, cancelMarketOrders, listOpenOrders }`).

- [ ] **Step 6: Run the tests.** Run: `npx vitest run src/lib/polymarket/orders.test.ts src/commands/polymarket/trade.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/polymarket/orders.ts src/lib/polymarket/orders.test.ts src/commands/polymarket/trade.ts src/commands/polymarket/trade.test.ts
git commit -m "feat(polymarket): buy and sell with price guards; orders and cancel"
```

---

### Task 9: Account and portfolio commands: setup, status, import-key, positions, redeem, activity, pnl

**Files:**
- Create: `src/commands/polymarket/account.ts`, `src/commands/polymarket/portfolio.ts`, `src/commands/polymarket/account.test.ts`

**Interfaces:**
- Consumes: Tasks 2–7.
- Produces: `setupCommand`, `statusCommand`, `importKeyCommand`, `positionsCommand`, `redeemCommand`, `activityCommand`, `pnlCommand`.

**Behavior:**
- **`setup [--wallet]`** (write):
  - It needs the OMS wallet to exist (`omsAddress`) and calls `assertCanTrade(await checkRegion())`.
  - Dry run: `{ dryRun: true, exists, account?, steps: ['create trading key', 'mint builder key', 'deploy Deposit Wallet (gasless)', 'set trading approvals (gasless)'] }`, with the already-done steps removed when `exists`.
  - Broadcast: `setupAccount` → `{ account: { kind, wallet, signer }, created, approvalsSet, next: 'agent polymarket deposit <usd> --broadcast' }`.
- **`status [--wallet]`** (read):
  - When no account exists: `{ setUp: false, next: 'agent polymarket setup --broadcast' }`.
  - Otherwise: `{ setUp: true, account: { kind, wallet }, pusd, approvals: isFullyApproved, region: { country, blocked, closeOnly }, openOrders: count, redeemable: { count, valueUsd }, pendingDeposit? }`.
  - The redeemable figures come from `client.listPositions({ status: 'REDEEMABLE' }).firstPage()`, summing `currentValue`. `pendingDeposit` comes from `loadPending`.
- **`import-key <privateKey> [--wallet]`**: `importLegacyKey` → `{ account }`, with a note that this is a legacy proxy account.
- **`positions [--status] [--limit] [--cursor] [--wallet]`**:
  - Same flags and output as #145, but the address is `requireAccount(wallet).wallet`.
  - For an install with no Polymarket account but an old `set-key` key, fall back to the legacy proxy derived from `loadPolymarketKey()`. This keeps old installs readable.
- **`redeem [<ref>] [--all] [--wallet]`** (write):
  - `--all` redeems every `REDEEMABLE` position's `conditionId`, de-duplicated.
  - `<ref>` resolves to a `conditionId` through `resolveOutcome(ref, 'yes')`.
  - Dry run lists `{ conditionId, title, valueUsd }`.
  - Broadcast calls `client.redeemPositions({ conditionId })` for each and waits; one failure doesn't stop the others. Output: `{ redeemed: [{ conditionId, txHash }], failed: [{ conditionId, error }] }`.
- **`activity [--limit 20] [--cursor] [--wallet]`**: `client.listActivity({ pageSize, cursor })` → `{ items: [{ type, time: iso, title, outcome, side, shares, amount, price, txHash }], nextCursor }`.
- **`pnl [--interval 1d|1w|1m|max] [--wallet]`**: `client.fetchUserPnl({ interval })` and `client.fetchPortfolioValue()` → `{ valueUsd, interval, realized: last point's realizedPnl, unrealized: last point's unrealizedPnl, points: up to 30 sampled }`.

- [ ] **Step 1: Write the failing test** `account.test.ts`. Mock `../../lib/polymarket/account.ts` (`planSetup`, `setupAccount`, `loadAccount`, `getTradingClient`, `pusdBalance`) and `region.ts`. Assert that:
  - `setup --dry-run` with no account lists four steps and does **not** call `setupAccount`;
  - `setup --broadcast` calls `setupAccount('main')` once;
  - `status` without an account returns `{ ok: true, setUp: false, next: 'agent polymarket setup --broadcast' }`;
  - `status` with an account returns `pusd: '2.5'` for `pusdBalance` 2_500_000n and `redeemable: { count: 1, valueUsd: '1.2' }` for one REDEEMABLE position with `currentValue: '1.2'`;
  - `redeem --all --broadcast` with two positions sharing one conditionId calls `redeemPositions` once.

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL.

- [ ] **Step 3: Implement `account.ts` and `portfolio.ts`** to the behavior above, following the handler pattern in `funds.ts` (`try { ... ok(...) } catch (err) { fail(err) }`; writes use `withWriteFlags` and `resolveBroadcast`).

- [ ] **Step 4: Run it and confirm it passes.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/polymarket/account.ts src/commands/polymarket/portfolio.ts src/commands/polymarket/account.test.ts
git commit -m "feat(polymarket): setup, status, import-key, positions, redeem, activity, pnl"
```

---

### Task 10: Wire up `polymarketCommand`, remove the old code, enable session mode

**Files:**
- Create: `src/commands/polymarket/index.ts`, `src/commands/polymarket/index.test.ts`
- Modify: `src/index.ts` (import path), `src/lib/polymarket/gamma.ts` (remove dead CLOB/proxy-execute code)
- Delete: `src/commands/polymarket.ts`, `src/commands/polymarket.test.ts`, `src/commands/polymarket-commands.test.ts` (their surviving assertions move into the new tests)
- Modify: `package.json` (remove `@polymarket/clob-client-v2` and `@polymarket/sdk` if nothing imports them; `getPolymarketProxyWalletAddress` uses `@polymarket/sdk`, so reimplement it with viem `getContractAddress` CREATE2 or keep that one dependency, whichever is less code. Keeping it is fine.)

**Interfaces:**
- Produces: `polymarketCommand: CommandModule`, which registers:
  - setup, status, import-key, deposit, withdraw, markets, event, market, book, history, buy, sell, orders, cancel, positions, redeem, activity, pnl
  - hidden aliases (`describe: false`):
    - `clob-buy <ref> <outcome> <amount>` → buy handler
    - `proxy-wallet` → status
    - `approve` → setup
    - `set-key <privateKey>` → import-key

- [ ] **Step 1: Write the failing `index.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

const { polymarketCommand } = await import('./index.ts');

describe('polymarketCommand', () => {
  it('registers the new commands and keeps old names as hidden aliases', async () => {
    const yargs = (await import('yargs')).default;
    const y = yargs().command(polymarketCommand);
    // yargs exposes registered subcommands through its internal command instance
    const help = await new Promise<string>((resolve) => {
      y.parse(['polymarket', '--help'], (_e: unknown, _a: unknown, out: string) => resolve(out));
    });
    for (const name of ['setup', 'status', 'deposit', 'withdraw', 'event', 'book', 'history', 'buy', 'sell', 'cancel', 'redeem', 'activity', 'pnl']) {
      expect(help).toContain(name);
    }
    for (const hidden of ['clob-buy', 'proxy-wallet', 'set-key', ' approve']) {
      expect(help).not.toContain(hidden);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.** Expected: FAIL (module not found).

- [ ] **Step 3: Implement `index.ts`** with `builder: (y) => y.command(setupCommand)...command({ ...buyCommand, command: 'clob-buy <ref> <outcome> <amount>', describe: false, aliases: [] })...demandCommand(1, '').showHelpOnFail(true)`. Map `amount` to `usd` in the alias handler. Point `src/index.ts` at `./commands/polymarket/index.ts`.

- [ ] **Step 4: Delete the old files and the session-mode refusal**

```bash
git rm src/commands/polymarket.ts src/commands/polymarket.test.ts src/commands/polymarket-commands.test.ts
```
- Remove `executeViaProxyWallet`, `getClobClient`, `createAndPostOrder`, `createAndPostMarketOrder`, `getOpenOrders`, `cancelOrder` and `getClobPrice`/`getOrderBook` from `gamma.ts`, unless something still imports them (`grep -rn` first).
- Keep `getMarkets`, `getMarket`, `parseMarket`, `assertTradable`, `getPositions`, `PolymarketError`, the constants and `getPolymarketProxyWalletAddress`.
- The `refuseInSessionMode` behavior is gone on purpose: deposits go through the allowance.

- [ ] **Step 5: Run the full suite, typecheck, lint and build**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && node dist/index.js polymarket --help`
Expected: everything passes, and the help lists the new commands but not the aliases.

- [ ] **Step 6: Check that it starts on Node 22**

Run: `npx -y node@22 dist/index.js polymarket markets --limit 1` and `npx -y node@22 dist/index.js polymarket book <a live market slug> yes`.
Expected: both print `ok: true`. If the SDK fails to load on Node 22, wrap `loadSdk()` so it throws `CliError({ code: 'invalid_input', message: 'Polymarket trading needs Node 24 or newer (found <version>).' })`, add a test for it, and note it in the skill.

- [ ] **Step 7: Commit**

```bash
git add -A src package.json ../../pnpm-lock.yaml
git commit -m "feat(polymarket): new command surface; remove proxy-wallet trading path; allow session mode"
```

---

### Task 11: Skills, docs and changeset

**Files:**
- Rewrite: `skills/polygon-polymarket/SKILL.md`
- Modify: `skills/polygon-oms-wallet/SKILL.md:128`; `skills/polygon-agent-cli/SKILL.md` (line 52 session-mode list, line 283 file structure, plus a Polymarket command block in Commands Reference); `packages/polygon-agent-cli/README.md` (Polymarket section, if present)
- Create: `.changeset/polymarket-deposit-wallet.md`

- [ ] **Step 1: Rewrite `skills/polygon-polymarket/SKILL.md`**

Keep the frontmatter `name: polymarket-skill` and update the `description` to mention setup, deposit, buy/sell by outcome name, and withdraw. The body, in this order:
1. **Start here:** run `agent polymarket status`, then a table from status to the next command:
   - `setUp: false` → `setup --broadcast`
   - `pusd: '0'` → `deposit <usd> --broadcast` (min $2)
   - `region.closeOnly` → only sell, cancel, redeem, withdraw
   - `redeemable.count > 0` → `redeem --all --broadcast`
2. **How money moves:** the OMS wallet → `deposit` → Polymarket wallet (pUSD) → trades → `withdraw` → the OMS wallet. One sentence for session mode: deposits count against the allowance, and the Polymarket wallet is controlled by this install, not the allowance.
3. **Finding markets:** `markets --search`, `event <slug>`, `market <slug>`, `book`, `history`. Explain refs (conditionId, market slug, or event slug plus outcome name, e.g. `event-slug "Bob"` or `"Bob no"`).
4. **Trading:**
   - `buy <ref> <outcome> <usd> [--max-price]`: always pass `--max-price` on market buys; suggest the dry run's `estimatedPrice` plus 0.02, capped at 0.99.
   - `sell <ref> <outcome> <shares|all> [--min-price]`.
   - Limit orders: `--price`, `--expires`.
   - `orders`, `cancel`.
5. **After resolution:** `positions --status REDEEMABLE`, `redeem --all --broadcast`.
6. **Reporting:** `activity`, `pnl`.
7. **Error codes table:** every code in `PolymarketErrorCode` with the fix.
8. **Rules for agents:**
   - always dry-run first;
   - never retry a `deposit` after `bridge_pending` without checking `status`;
   - never use `--again` unless the user asks;
   - show the user `estimatedPrice` and shares before broadcasting a buy above $10.
9. **Legacy:** `import-key` for old Polymarket proxy accounts; `withdraw all` drains them.

Follow the voice rules in `~/.claude/CLAUDE.md`: no em dashes, no "AI-powered", short sentences.

- [ ] **Step 2: Update the other skills**
- `skills/polygon-oms-wallet/SKILL.md:128`: remove "Polymarket" from the `owner_required` list. Add a short "Polymarket" paragraph: setup and deposit work with the allowance; deposits count against it; point to the polymarket skill.
- `skills/polygon-agent-cli/SKILL.md:52`: remove `polymarket` from "What doesn't". At line 283, replace the builder.json polymarket note with `polymarket/<wallet>/  # Polymarket trading key, builder key, account (encrypted)`.

- [ ] **Step 3: Write the changeset**

```markdown
---
"@polygonlabs/agent-cli": minor
---

Polymarket trading through a CLI-managed Polymarket Deposit Wallet.

- `polymarket setup` creates a trading key, deploys a Deposit Wallet and sets approvals through Polymarket's relayer, with no key import and no POL needed.
- `deposit` and `withdraw` move money between the OMS wallet and Polymarket through Polymarket's bridge. Deposits are plain USDC transfers, so they work in session mode and count against the allowance.
- New `status`, `event`, `book`, `history`, `buy`, `sell`, `cancel --all`, `redeem`, `activity` and `pnl`. Markets can be named by slug, and outcomes by name, including multi-outcome events.
- `buy --max-price` and `sell --min-price` refuse a worse estimated fill before posting.
- Region checks: blocked regions can't trade, and close-only regions can only sell, cancel, redeem and withdraw.
- `clob-buy`, `proxy-wallet`, `approve` and `set-key` remain as hidden aliases for one release.
```

- [ ] **Step 4: Format and check**

Run: `npx prettier --write skills/polygon-polymarket/SKILL.md .changeset/polymarket-deposit-wallet.md && pnpm -w lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add skills .changeset packages/polygon-agent-cli/README.md
git commit -m "docs(polymarket): rewrite the Polymarket skill for Deposit Wallet trading"
```

---

### Task 12: Live milestone (needs the user's go-ahead at the broadcast step; about $3 at risk)

**Files:** none committed, except fixes found here (each in its own `fix:` commit with a regression test).

- [ ] **Step 1: Owner mode, dry runs first**

```bash
A="npx tsx src/index.ts"
$A polymarket status
$A polymarket setup --dry-run
$A polymarket deposit 3 --dry-run
```
Expected: `setUp: false`, four setup steps, and a deposit dry run naming the bridge address.

- [ ] **Step 2: Ask the user to confirm before broadcasting.** Show the planned sequence and the $3 amount. Wait for an explicit yes.

- [ ] **Step 3: Broadcast the owner-mode run**

```bash
$A polymarket setup --broadcast
$A polymarket deposit 3 --broadcast
M=$($A polymarket markets --limit 1 | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).markets[0].conditionId))")
$A polymarket buy $M yes 1 --dry-run
$A polymarket buy $M yes 1 --max-price 0.99 --broadcast
$A polymarket positions
$A polymarket sell $M yes all --broadcast
$A polymarket withdraw all --broadcast
$A polymarket status
```
Record:
- whether the order needed Polymarket's terms of service to be accepted (an `order_rejected` with a terms message). If so, add a `terms_required` code and a status hint.
- that funds arrived back in the OMS wallet as USDC.

- [ ] **Step 4: Session mode.** On a session-mode install, run `setup` and `deposit 2` again. Confirm the deposit shows up in `wallet allowance` spending, then buy, sell and withdraw.

- [ ] **Step 5: Polymarket V2 markets.** If any `version: 'v2'` market is open (`markets --limit 100`, look for `version`), run `buy <v2> yes 1 --dry-run` and then a $1 broadcast. If it fails, keep `assertTradable`-style refusal for v2 in `resolveOutcome` (`unsupported_market_version`) with a test.

- [ ] **Step 6: Report.** Summarize the tx hashes, the amounts in and out, and any fixes, and update the PR description.
