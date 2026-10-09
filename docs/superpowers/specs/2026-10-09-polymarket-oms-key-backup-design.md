# Polymarket trading key backed by OMS

Date: 2026-10-09. Status: approved in conversation (James). Addendum to `2026-10-08-polymarket-v2-design.md`. Branch: `polymarket-v2` (PR #146).

## Problem

The Polymarket trading key lives only on the machine running the CLI. If an assistant's VM or workspace is wiped, the key is gone, and so is everything in the Deposit Wallet, because only that key can move funds out. Polymarket has no recovery path.

## What we verified (2026-10-09, live, no funds)

- **Import.** `OMSWallet.importWallet({ type: 'ethereum', privateKey, reference })`, run while signed in as the owner, imports a key into the OMS enclave under the user's account. The resulting wallet's address is the plain EOA.
- **Signing.** OMS `signTypedData` for that wallet returns a 65-byte ECDSA signature that recovers to the EOA.
- **Full Polymarket flow.** With OMS as the only signer, `@polymarket/client` did all of the following (3 OMS signatures):
  - created the CLOB API key
  - minted a builder key
  - deployed a Deposit Wallet through the relayer
  - set approvals with an owner-signed relayer batch
- **No funds needed.** Importing is an API call, and Polymarket's relayer pays for deployment and approvals.
- **No export.** OMS never hands a key back, so recovery means OMS signs as the key.
- **Wallet order.** `listWallets` returns wallets oldest first. Automatic wallet selection at sign-in picks the first one listed.

## Decisions (James)

- Every agent CLI user gets one extra imported wallet in their OMS account: the Polymarket trading key, with reference `polymarket-trading-key`.
- Connecting stays a single step. Polymarket is connected during whatever owner sign-in the user is already doing, and it never asks for its own sign-in.

## Design

### Key lifecycle

1. **Generate.** The CLI generates the trading key locally, as it does today.
2. **Back up.** During an owner sign-in, the CLI imports the key into OMS with reference `polymarket-trading-key`.
   - `account.json` records `backup: { omsWalletId, address, at }`.
   - The local encrypted copy stays, because assistants trade with it: OMS session keys can't sign.
   - Back-up is idempotent. If OMS already holds a wallet with that address, the CLI records its id and does not import again.
3. **Trade.** Trading keeps using the local key, so nothing changes for trading.

### Which owner sign-ins back up the key

- **Owner mode** (`wallet login`, an owner session lasting about a week): `polymarket setup --broadcast` backs up the key with the existing session. Rerunning `setup` backs up existing accounts.
- **Session mode** (email-code owner requests):
  - Every confirmed owner request (connect, allowance-set, renew, withdraw, access) runs a Polymarket step with the owner sign-in it already has.
  - If the wallet has no Polymarket key yet, the CLI generates one and backs it up. If it has an un-backed-up key, the CLI backs that up.
  - So a new connect brings Polymarket along with no extra code, and already-connected users are covered on their next owner action.
  - The step never fails the owner request it rides on. Any failure is reported as `polymarket: { backedUp: false, error }`.
- **`polymarket setup` in session mode** still needs no sign-in. Deploying and approving are signed locally through the relayer.

### Wallet selection safety

With two wallets in the account, the CLI must never act on the Polymarket key by mistake.
- **After every owner sign-in** (email confirm and browser login), the CLI explicitly calls `useWallet` on the user's main wallet. That is the wallet matching the stored pointer address, or for a first login the oldest wallet whose `keyOrigin` isn't `imported`. It doesn't rely on automatic selection.
- **Owner mode.** The persisted OMS session must stay on the main wallet. Every import, and every signature as the trading key, switches the active wallet only inside a helper that switches back in a `finally` block.
- **Startup guard.** If the persisted session's active wallet is not the pointer's address, the CLI switches back before doing anything. This covers a crash mid-switch.

### Recovery (local key missing, OMS backup present)

- **Detection.** `account.json` has a backup, or OMS lists a wallet with the `polymarket-trading-key` reference, but the local key file is missing.
- **Owner mode.** Polymarket commands sign through OMS as the backed-up key (the OMS-backed signer). Status, trading, redeem and withdraw all keep working, and `status` shows `signer: "oms"`. Nothing is stranded.
- **Session mode.** During the next confirmed owner request (a reconnect after a wipe is one), the Polymarket step signs through OMS as the old key and withdraws all pUSD to the OMS wallet. It then reports any positions left in the old account, which stay reachable in owner mode. The old account's record is kept under `polymarket/<wallet>/previous/`. Afterwards a new key is generated and backed up as usual.

### Out of scope

- Moving outcome-share positions to a new account automatically.
- Polymarket session keys.
- Deleting the spike test wallets: the OMS SDK has no delete call.
