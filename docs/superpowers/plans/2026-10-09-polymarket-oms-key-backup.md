# Polymarket OMS key backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Back up the Polymarket trading key in the user's OMS account during owner sign-ins they already do, so a wiped machine never strands Polymarket funds. Never pick the wrong OMS wallet by accident.

**Architecture:** A new `src/lib/polymarket/oms-key.ts` holds every OMS interaction:
- main-wallet selection
- scoped active-wallet switching
- idempotent key import
- an OMS-backed `@polymarket/client` signer

Owner-mode `setup` and every confirmed session-mode owner request call it. Recovery uses the OMS-backed signer.

**Tech Stack:** TypeScript, vitest, `@polygonlabs/oms-wallet` 0.3.1 (`listWallets`, `useWallet`, `importWallet`, `signTypedData`, `signMessage`), `@polymarket/client` 0.12.0.

**Spec:** `docs/superpowers/specs/2026-10-09-polymarket-oms-key-backup-design.md` (addendum to `2026-10-08-polymarket-v2-design.md`).

## Global Constraints

- All paths are relative to `packages/polygon-agent-cli/` unless they start with `skills/` or `docs/`.
- The OMS reference for the imported key is exactly `polymarket-trading-key`.
- **Never leave a session on the wrong wallet.**
  - Any `importWallet` call, and any signature as the trading key on a persisted OMS session, happens inside `withActiveWallet`, which switches back to the previous wallet in a `finally` block.
  - After every owner sign-in, the CLI calls `selectMainWallet`.
- The Polymarket step attached to owner requests is best-effort. It must never make the owner request itself fail. Its errors go into the result as `polymarket: { backedUp: false, error }`.
- Secrets are only stored through `encrypt` and `writeJsonFile`, and are never printed. The private key passed to `importWallet` is never logged.
- All output is JSON, and errors go through `errorJson`/`failureJson`. Tests mock OMS and the SDK, never hit the network, and never broadcast.
- Commit subjects are lower-case (commitlint), with no Co-Authored-By line.
- Known pre-existing test failure: `src/lib/workspace.test.ts` on macOS.

## Review Focus

1. **Wrong-wallet actions.** If an owner sign-in or a crash leaves the active OMS wallet on the imported Polymarket key, the next `runTx`, connect or withdraw must still act on the user's main wallet. The CLI must never send from or set sessions on the imported key. Pinned in Tasks 1 and 2.
2. **Duplicate imports.** Running backup twice, or for a key OMS already holds, must not import a second copy. It records the existing id. Pinned in Task 1.
3. **Owner request failures.** If the Polymarket step throws, the user's connect, renew or withdraw still succeeds and reports `polymarket.backedUp: false`. Pinned in Task 4.
4. **Recovery without a sign-in.** If the local key is missing and there is no owner session, commands fail with `not_set_up` and a hint to sign in. They never generate a replacement key over a funded account. Pinned in Task 5.
5. **Session-mode recovery.** It sweeps pUSD to the OMS wallet before generating a new key, and keeps the old account's records. Pinned in Task 5.

---

## File structure

```
src/lib/polymarket/oms-key.ts        selectMainWallet, withActiveWallet, findTradingKeyWallet, backupTradingKey, omsSigner (new)
src/lib/polymarket/oms-key.test.ts   (new)
src/lib/polymarket/account.ts        ensureTradingKey, backup.json read/write, OMS-signer fallback in getTradingClient, recoverAccount
src/lib/polymarket/owner-step.ts     polymarketOwnerStep: the best-effort step run during confirmed owner requests (new)
src/lib/owner/requests.ts            selectMainWallet after signIn
src/lib/owner/actions.ts             runOwnerAction calls polymarketOwnerStep
src/lib/browser-login.ts, src/commands/wallet.ts   selectMainWallet after OIDC sign-in
src/lib/oms-tx.ts                    ensureMainWallet guard before sending
src/commands/polymarket/account.ts   setup backs up (owner mode); status shows backup and signer
src/lib/polymarket/withdraw.ts       withdrawAll core, moved out of commands/polymarket/funds.ts and reused by recovery (new)
skills/polygon-polymarket/SKILL.md, skills/polygon-oms-wallet/SKILL.md, skills/setup.md
```

---

### Task 1: The OMS key module

**Files:** create `src/lib/polymarket/oms-key.ts` and `src/lib/polymarket/oms-key.test.ts`.

**Interfaces (produced):**
```ts
export const TRADING_KEY_REFERENCE = 'polymarket-trading-key';
// Minimal structural type so tests can pass a fake: listWallets, useWallet, importWallet, signTypedData, signMessage, walletAddress
export type OmsWalletLike = Pick<OMSWalletClient, 'listWallets' | 'useWallet' | 'importWallet' | 'signTypedData' | 'signMessage' | 'walletAddress'>;
export async function selectMainWallet(w: OmsWalletLike, opts: { expectedAddress?: string }): Promise<{ id: string; address: string }>;
export async function withActiveWallet<T>(w: OmsWalletLike, walletId: string, fn: () => Promise<T>): Promise<T>;
export async function findTradingKeyWallet(w: OmsWalletLike, address?: string): Promise<{ id: string; address: string } | null>;
export async function backupTradingKey(w: OmsWalletLike, privateKey: `0x${string}`): Promise<{ omsWalletId: string; address: string; imported: boolean }>;
export function omsSigner(w: OmsWalletLike, target: { walletId: string; address: string }): import('@polymarket/client').Signer; // type-only import
```

**Behavior:**
- **`selectMainWallet`**
  - Lists the wallets. If `expectedAddress` is given, it picks the wallet with that address, compared case-insensitively.
  - Otherwise it picks the first wallet in list order whose `keyOrigin !== 'imported'`.
  - It calls `useWallet` only when the active address differs.
  - If nothing qualifies, it throws `CliError({ code: 'not_connected', message: … })`.
- **`withActiveWallet`**
  - Records the current active wallet's id, found in `listWallets` by matching the active `walletAddress`.
  - Calls `useWallet(target)`, runs `fn`, then in a `finally` block calls `useWallet(previous)`.
  - If the target is already active, it just runs `fn`.
- **`findTradingKeyWallet`** matches by address first, then by `reference === TRADING_KEY_REFERENCE` among imported wallets. When matching by reference with an address given, a mismatched address does not count.
- **`backupTradingKey`**
  - Derives the address with viem `privateKeyToAccount`.
  - If OMS already lists that address, it returns `imported: false` with its id.
  - Otherwise it records the active wallet, calls `importWallet({ type: 'ethereum', privateKey, reference: TRADING_KEY_REFERENCE })` (which activates the import), restores the previous wallet in a `finally` block, and returns `imported: true`.
  - It verifies the imported address equals the derived address and throws `upstream_error` if not.
- **`omsSigner`**
  - `getAddress` returns the target address.
  - `signTypedData(payload)` adds an `EIP712Domain` type built from the domain's present fields (name, version, chainId, verifyingContract, salt), then calls `w.signTypedData({ network: findNetworkById(137), typedData })` inside `withActiveWallet(target)`.
  - `signMessage` does the same through `w.signMessage`.
  - `sendTransaction` throws `CliError invalid_input` with the message "gasless only".

**Tests** use a fake `OmsWalletLike` with an in-memory wallet list and active id that records calls:
1. `selectMainWallet` picks the expected address. Without one, it picks the first non-imported wallet even when an imported wallet is listed first. It throws `not_connected` when only imported wallets exist.
2. `withActiveWallet` restores the previous wallet when `fn` throws.
3. `backupTradingKey`:
   - imports once and restores the active wallet afterwards
   - a second call returns `imported: false` and makes no import call
   - an address mismatch throws
4. `omsSigner.signTypedData`:
   - adds `EIP712Domain`, signs while the target is active, and restores the active wallet afterwards
   - `sendTransaction` throws

- [ ] Write the failing tests and run them: `npx vitest run src/lib/polymarket/oms-key.test.ts` (FAIL).
- [ ] Implement, then run them again (PASS), then `pnpm typecheck && pnpm lint`.
- [ ] Commit: `feat(polymarket): oms key backup, wallet selection and oms-backed signer`.

### Task 2: Wallet-selection safety

**Files:**
- modify `src/lib/owner/requests.ts`, `src/lib/browser-login.ts`, `src/commands/wallet.ts` and `src/lib/oms-tx.ts`
- tests go next to each file, or in the existing wallet-session and browser-login tests

**Behavior:**
- **`confirmOwnerRequest`:** right after `signIn`, it calls `selectMainWallet(owner.wallet, { expectedAddress: (await loadOmsWalletPointer(wallet))?.walletAddress })` and uses the returned address as `context.walletAddress`, not `auth.walletAddress`.
- **Browser login** (`browser-login.ts`) **and `wallet login`** (`commands/wallet.ts`): after `completeOidcRedirectAuth`, they call `selectMainWallet(oms.wallet, { expectedAddress: existingPointer?.walletAddress })`. The saved pointer uses the selected address.
- **`ensureMainWallet(walletName)`** is exported from `oms-tx.ts` (or a small helper beside it).
  - For an owner-mode pointer, it gets `getOmsClient(walletName).wallet` and returns if `walletAddress` equals the pointer address.
  - Otherwise it finds the pointer's wallet id in `listWallets` and calls `useWallet` on it.
  - `runOmsTx` awaits it before sending.

**Tests:**
- confirm with an auto-selected imported wallet ends with `context.walletAddress` equal to the pointer address, and `useWallet` was called
- browser login with two wallets saves the non-imported address
- `runOmsTx` with a persisted session on the imported wallet switches back before sending, and the send uses the main address

- [ ] TDD as in Task 1. Commit: `fix(wallet): always act on the main oms wallet when an imported key exists`.

### Task 3: Owner-mode backup in `setup`, the backup record, and status

**Files:** `src/lib/polymarket/account.ts`, `src/commands/polymarket/account.ts` and its tests.

**Behavior:**
- **`ensureTradingKey(wallet)`** is extracted from `setupAccount`. It returns the existing key or generates and stores one, and never deploys anything.
- **`readBackup(wallet)` and `writeBackup(wallet, b)`** manage `polymarket/<wallet>/backup.json` = `{ omsWalletId, address, at }`. It is plaintext and holds no secret. Reads must not create directories; use the existing non-creating `accountFile` helper.
- **`setup --broadcast`, owner mode** (the pointer `access` isn't `'session'` and the owner session is live):
  - after `setupAccount`, it calls `backupTradingKey(getOmsClient(wallet).wallet, key)` and writes `backup.json`
  - it then calls `ensureMainWallet(wallet)` as a final guard
  - output gains `backup: { omsWalletId, imported }`
  - if no owner session is live, output has `backup: { backedUp: false, hint: 'agent wallet login' }`, and setup still succeeds
- **`setup --dry-run`** lists `back up the trading key to OMS` when `backup.json` is missing.
- **`status`** gains `backup: { backedUp: boolean, omsWalletId? }` and `signer: 'local' | 'oms'`.

**Tests:**
- `setup` in owner mode backs up once and writes `backup.json`
- a rerun makes no import
- `setup` without a live session still succeeds, with `backedUp: false`
- `status` shows the backup field

- [ ] TDD. Commit: `feat(polymarket): back up the trading key to oms during setup`.

### Task 4: The session-mode owner step (single-step connect)

**Files:**
- create `src/lib/polymarket/owner-step.ts` and its test
- modify `src/lib/owner/actions.ts` (`runOwnerAction`)
- modify `src/commands/wallet-session.ts` only if its output shape needs the new field

**Interface:**
```ts
export async function polymarketOwnerStep(p: { wallet: string; owner: OmsWalletLike; mainAddress: string }): Promise<{ backedUp: boolean; omsWalletId?: string; created?: boolean; recovered?: Record<string, unknown>; error?: string }>
```

**Behavior:**
- If a local key exists and has a backup, return `backedUp: true`.
- If a local key exists without a backup, back it up.
- If there is no local key and no account (no `account.json`), `ensureTradingKey`, then back it up and report `created: true`.
- If there is an account with its key missing, run recovery (Task 5).
- Afterwards, always `selectMainWallet(owner, { expectedAddress: mainAddress })`.
- Wrap everything in try/catch. On error, return `{ backedUp: false, error: message }`; never throw.

**`runOwnerAction`:** after the action and the existing `retireParkedRacs`, it calls the step with `context.owner.wallet`, `wallet` and `context.walletAddress`, and adds `polymarket: …` to the result.

**Tests:**
- connect for a wallet with no Polymarket key creates and backs one up
- a later action makes no second import
- if the step throws, the action result is unchanged apart from `polymarket.backedUp: false`
- the step selects the main wallet afterwards

- [ ] TDD. Commit: `feat(polymarket): connect polymarket during existing owner sign-ins`.

### Task 5: Recovery

**Files:**
- create `src/lib/polymarket/withdraw.ts`, moving the core of `handleWithdraw` (the balance, the bridge address bound to the recipient, and `transferErc20` to the bridge) into `withdrawAll({ client, account, recipient, broadcast })`
- update `src/commands/polymarket/funds.ts` to call it, with no behavior change
- modify `account.ts` and `owner-step.ts`, plus tests

**Behavior:**
- **`getTradingClient(wallet)` when the key file is missing but a backup exists** (from `backup.json`, or `findTradingKeyWallet` on a live owner-mode session):
  - with an owner-mode session live, build the client with `signer: omsSigner(...)` and the stored builder key
  - with no owner session, throw `CliError({ code: 'not_set_up', message: 'The Polymarket key is not on this machine; it is backed up in your OMS account.', hint: 'Sign in with agent wallet login to use it.' })`
  - never generate a new key in this path
- **`status`** reports `signer: 'oms'` in that case.
- **`recoverAccount({ wallet, owner, mainAddress })`** runs when `polymarketOwnerStep` finds an account with its key missing:
  1. builds an OMS-signer client for the old key (the owner sign-in is live inside the request)
  2. runs `withdrawAll` to `mainAddress`, if pUSD is above 0
  3. lists positions with the client's `listPositions`, first page, status OPEN
  4. moves `polymarket/<wallet>/` to `polymarket/<wallet>/previous-<timestamp>/`, excluding the `previous-*` folders
  5. calls `ensureTradingKey` and backs up the new key
  6. returns `recovered: { withdrawnUsd, txHash, positionsLeft: [...], previousAccount: address }`

  If `withdrawAll` fails, it stops before moving anything and returns `backedUp: false` with the error.

**Tests:**
- missing key with a backup and an owner session uses the OMS signer
- with no session it returns `not_set_up` and makes no key file
- recovery withdraws, archives, creates a new key and reports positions
- a withdraw failure changes nothing on disk

- [ ] TDD. Commit: `feat(polymarket): recover the account through oms when the local key is gone`.

### Task 6: Skills, docs and live check

**Files:** `skills/polygon-polymarket/SKILL.md`, `skills/polygon-oms-wallet/SKILL.md`, `skills/setup.md`, the spec status line, and a changeset. Add to `.changeset/polymarket-deposit-wallet.md`; don't create a new file.

**Docs:**
- Explain that connecting backs up the Polymarket key to the user's OMS account (one extra wallet labelled `polymarket-trading-key`).
- Explain that a wiped machine loses nothing: the next sign-in recovers.
- Explain what `status.backup` and `status.signer` mean.
- Voice rules: no em dashes, short sentences.

**Live check** (the controller runs it, not the implementer; no funds move):
1. On `main` (owner mode), run `polymarket setup --broadcast` to back up the existing key `0x755E…F33e`. Confirm `backup.imported: true` and that the OMS wallet list shows it with the right reference. Confirm `main` stays active.
2. Move `polymarket/main/key.json` aside, then run `polymarket status` (expect `signer: 'oms'`) and `polymarket withdraw all --dry-run` (works). Put the file back.

- [ ] Docs commit: `docs(polymarket): document oms-backed key and recovery`.
