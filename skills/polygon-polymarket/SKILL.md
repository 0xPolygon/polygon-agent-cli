---
name: polymarket-skill
description: Trade Polymarket prediction markets with the Polygon Agent CLI. Set up a Polymarket account, deposit USDC from the OMS wallet, find markets, buy and sell outcomes by name (for example "Bob" or "Bob no") with price guards, redeem winners, and withdraw back to the OMS wallet. All commands print JSON. Write commands are dry-run unless you pass --broadcast.
---

# Polymarket skill

Every command is `agent polymarket <command>`. Output is JSON on stdout, and failures are JSON on stderr with a `code`, a `hint`, and sometimes a `command` to run next. Write commands (`setup`, `deposit`, `withdraw`, `buy`, `sell`, `cancel`, `redeem`) preview by default. Add `--broadcast` to execute. The account, money, trading and portfolio commands take `--wallet <name>` (default `main`), the OMS wallet that owns the Polymarket account. The discovery commands (`markets`, `event`, `market`, `book`, `history`) don't take it.

## Start here

Run this before anything else:

```bash
agent polymarket status
```

Then pick the next step from what it reports. Check the region rows first:

| status shows | Next command |
| --- | --- |
| `region.blocked: true`, or any command fails with `region_blocked` | Stop. Polymarket is not available from this region. `setup`, `deposit`, `withdraw`, `buy`, `sell` and `redeem` all fail. |
| `region.closeOnly: true` | Only close positions: `sell`, `cancel`, `redeem` and `withdraw`. `buy` fails with `region_close_only`. |
| `setUp: false` | `agent polymarket setup --broadcast` |
| `pusd: "0"` | `agent polymarket deposit <usd> --broadcast` (minimum $2) |
| `pendingDeposit` present | Wait. Run `status` again in a few minutes. Do not deposit again. |
| `redeemable.count > 0` | `agent polymarket redeem --all --broadcast` |

Region rules come from Polymarket at run time: its geoblock endpoint decides whether a region is blocked, and the CLOB's close-only flag decides whether it may only close positions. Don't guess them from a location. `status` shows the region only once the account is set up; before that, `setup` itself fails with `region_blocked` in a blocked region.

`status` also shows `approvals`, `openOrders`, and `redeemable.valueUsd`. If `redeemable.truncated` is `true`, more than 2000 rows were redeemable. Redeem, then run `status` again.

If `status.otherTradingKeys` is non-empty, those are other installs' keys or an old key from before a reinstall. `polymarket recover <address> --broadcast` (owner mode only) moves that account's cash back to the OMS wallet. Run it without `--broadcast` first to see the balance and open positions.

`setup` needs no key import and no POL. It creates a trading key, deploys the Polymarket wallet, and sets approvals through Polymarket's relayer. It is safe to rerun: it only redoes the approvals check once the account exists.

### Key backup and recovery

The trading key lives on this machine, and only it can move funds out of the Polymarket wallet. So the CLI backs it up to the user's OMS account as one extra imported wallet, labelled `polymarket-trading-key:<install name>`. Each install has its own. The local copy stays, because trading signs with it. An extra wallet in the user's OMS account list is expected.

When the backup happens:

- Owner mode: `setup --broadcast` imports the key with the existing sign-in. Rerun `setup --broadcast` on an account that predates the backup. The result has `backup: { omsWalletId, imported }`. If it fails, the result has `backup.backedUp: false` with an `error` and the setup itself still succeeds. With the key present but no owner sign-in, the result has `backup: { backedUp: false, hint: 'agent wallet login' }`. With the key missing and no sign-in, `setup` refuses with `not_set_up`, because OMS can't be checked for a backup. Run `agent wallet login` and rerun it.
- Session mode: every confirmed owner request (connect, allowance, renew, withdraw, access) backs it up with the owner sign-in it already has. It creates the key first if there is none. Connecting needs no extra step, and the owner request never fails because of it. The outcome is in the request's `polymarket` field (`backedUp`, or `backedUp: false` with an `error`).

`status` shows two fields about this:

| Field | Meaning |
| --- | --- |
| `signer` | `local`: the key file is on this machine. `oms`: it is gone and OMS signs as the backed-up key. Status, trading, redeem and withdraw all keep working. This is owner mode only. In session mode with the key gone, commands fail with `not_set_up` until the next owner approval recovers it. |
| `backup` | `{ backedUp: true, omsWalletId }` once the key is in OMS. `{ backedUp: false }` if not. |

A wiped machine loses nothing, as long as the user reinstalls with the same `--name` (see setup.md), because the backup is found by that label.

- Owner mode: run `setup --broadcast`. It restores the account from OMS and never makes a new key over it (`restored: true`, `signer: "oms"`).
- Session mode: the next confirmed owner request recovers it. It withdraws all pUSD from the old account to the OMS wallet, archives the old records under `polymarket/<wallet>/previous-<timestamp>/`, then creates a new key and backs it up. Run `setup --broadcast` afterwards to deploy the new account. Open positions stay in the old account and are reachable in owner mode. If a deposit is still being credited, or a legacy proxy still holds funds, the recovery stops after the sweep (`backedUp: false` with an `error`). The pUSD has already moved to the OMS wallet and the result reports it in `recovered`, but the old key stays in use and the next owner request retries the rotation. For the legacy proxy case the hint is to sign in with `agent wallet login` to use it through OMS. If local records name the lost key and OMS holds no backup of it, nothing is changed and no new key is made. With no local records and no OMS key for this install name, the step creates a new key and backs it up.

`status.otherTradingKeys` lists backed-up keys this install doesn't track (owner mode only), such as another install's key or one from before a reinstall. `polymarket recover <address> --broadcast` moves that account's pUSD to the OMS wallet. It refuses addresses that are not Polymarket trading keys in the OMS account and this install's own key. It leaves open positions in place, and a dry run lists them.

## How money moves

```
OMS wallet --deposit--> Polymarket wallet (pUSD) --buy / sell--> positions
OMS wallet <--withdraw-- Polymarket wallet (pUSD)
```

- `deposit <usd>` sends Polygon USDC from the OMS wallet to Polymarket's bridge, then waits for pUSD to be credited. Minimum $2.
- `withdraw <usd|all>` always pays the OMS wallet as Polygon USDC. It moves pUSD only.
- Trades use pUSD in the Polymarket wallet. A buy never touches the OMS wallet.
- In session mode, `deposit` is a plain USDC transfer, so it counts against the allowance. The Polymarket wallet is controlled by this install's trading key, not by the allowance, so trades and withdrawals are not limited by it.

### deposit

```bash
agent polymarket deposit 25            # dry run: shows from, bridgeAddress, polymarketWallet, amountUsd
agent polymarket deposit 25 --broadcast
```

| Flag | Meaning |
| --- | --- |
| `--again` | Send even if an earlier deposit is still pending. Only when the user asks. |
| `--no-wait` | Return after the transfer instead of waiting up to 5 minutes for the credit. |

- In session mode the dry run adds an `allowance` object (`usd`, `allowanceUsd`, `spentUsd`) so you can see the impact.
- Output on broadcast: `txHash`, `credited`, `amountUsd`, and `pusdBalance` when credited. `credited: false` means the bridge is still working. Run `status` later.
- A deposit that was sent but not yet credited makes a rerun fail with `bridge_pending` (`details.txHash`). Check `status` before doing anything else.
- If the bridge reports the earlier deposit as FAILED, the error is `upstream_error` with a hint to https://recovery.polymarket.com.
- If the OMS wallet holds less USDC than the amount, the error is `insufficient_balance` with a `swap` hint. The same code, with a hint to fund the wallet, means it can't pay the relayer fee. Nothing was sent in either case.
- Two deposits for one wallet can't run at once. The second fails with `wallet_busy` and sends nothing. Run `status` before trying again.

### withdraw

```bash
agent polymarket withdraw 10           # dry run: amountUsd, from, to, via
agent polymarket withdraw all --broadcast
```

- Output on broadcast: `txHash`, `amountUsd`, `to`, and a `note`. The `txHash` is the pUSD transfer to Polymarket's bridge, not the USDC payout. The USDC arrives in the OMS wallet shortly after.
- Fails with `insufficient_pusd` when the amount is zero or more than the balance.

## Finding markets

| Command | Use |
| --- | --- |
| `markets [--search <text>] [--limit <n>] [--cursor <c>]` | List active markets by volume. Page with `nextCursor`. `--cursor` works on the plain listing, not with `--search`. |
| `event <slug> [--all]` | An event and its open markets. `--all` adds closed ones. |
| `market <ref> [--all]` | One market by conditionId or market slug. An event slug lists that event's markets. |
| `book <ref> <outcome> [--depth <n>]` | Order book: `bestBid`, `bestAsk`, `spread`, `bids`, `asks`, `minOrderSize`, `tickSize`. |
| `history <ref> <outcome> [--interval 1h\|6h\|1d\|1w\|1m\|max] [--points <n>]` | Price history. |

### Refs and outcomes

A `<ref>` is one of:

- a conditionId (`0x` plus 64 hex characters),
- a market slug, or
- an event slug, with the outcome name as the next argument.

The `<outcome>` is `yes`, `no`, or the outcome name. For a market, the names are its two labels. For a multi-outcome event, name the entry and optionally add `yes` or `no`:

```bash
agent polymarket book some-event-slug "Bob"        # Bob, yes side
agent polymarket book some-event-slug "Bob no"     # Bob, no side
agent polymarket buy 0xdf8e...d4a8 yes 5          # by conditionId
```

An entry title that matches the whole input wins over reading a trailing `yes` or `no` as the side: if an event has entries "Vote" and "Vote No", then `"Vote No"` is the "Vote No" entry's yes side, and `"Vote No no"` is its no side. Partial names match when only one entry contains them. `outcome_not_found` and `ambiguous_market` carry `details.choices`, the valid names. Pick one and retry.

The `markets` listing has no slug field. Take the `conditionId` from it, or find slugs through `event` and `market`.

## Trading

Always dry-run first, read the result, then repeat with `--broadcast`.

### buy

```bash
agent polymarket buy <ref> <outcome> <usd> [--max-price <0-1>] [--price <0-1> [--expires <minutes>]]
```

- Market buy: pass `--max-price` every time. Run the dry run first. Take its `estimatedPrice`, add 0.02, cap at 0.99, and use that as `--max-price`.
- `<usd>` is the all-in spend: fees come out of it, so a market buy never spends more than the amount you pass.
- A closed or paused market fails with `market_not_accepting_orders` before anything else is checked.
- If the estimate is already above `--max-price`, the command fails with `price_guard` (`details.estimatedPrice`) and posts nothing. The venue enforces `--max-price` again at fill time.
- Dry run output: `orderType`, `estimatedPrice`, `estimatedShares`.
- Limit buy: `--price` rests an order at that price. Add `--expires <minutes>` (at least 3) to make it expire. `--expires` only works with `--price`. On a market order it is `invalid_input`. `--price` cannot be combined with `--max-price` (`invalid_input`).
- Not enough pUSD fails with `insufficient_pusd`. The hint is a `deposit` command.
- Broadcast output: `orderId`, `status`, `filledUsd`, `filledShares`, `txHashes`.
- A refusal from the exchange is `order_rejected`, with the exchange's code in `details.venueCode`.

### sell

```bash
agent polymarket sell <ref> <outcome> <shares|all> [--min-price <0-1>] [--price <0-1> [--expires <minutes>]]
```

- `<shares>` is a plain decimal such as `12.5`, or `all`. `all` sells the whole position. If you hold nothing, the error is `insufficient_shares`. Asking for more than you hold is the same error.
- Holdings come from the refreshed on-chain balance, not from `positions`, so a recent fill shows up sooner there.
- `--expires` only works with `--price`, as for `buy`.
- `--min-price` is the sell-side guard (`price_guard` with `details.estimatedPrice`). `--price` cannot be combined with `--min-price`.
- `sell` works in close-only regions.

### Orders

```bash
agent polymarket orders [--market <ref>]               # open orders: id, market, outcome, side, price, size, filled, expiresAt
agent polymarket cancel <orderId> --broadcast
agent polymarket cancel --all --broadcast
agent polymarket cancel --market <ref> --broadcast
```

Pass exactly one of an order id, `--all`, or `--market`. A dry run lists what would be canceled.

## After resolution

```bash
agent polymarket positions --status REDEEMABLE        # winners waiting to be redeemed
agent polymarket redeem --all --broadcast
agent polymarket redeem <ref> --broadcast             # one market
```

`positions --status` takes `OPEN` (default, includes unredeemed winners), `REDEEMABLE`, `REDEEMABLE_LOST`, `MERGEABLE` or `CLOSED`. It also takes `--limit` and `--cursor`. The `redeem --all` output has `redeemed` and `failed` lists. If at least one redemption worked, the result is `ok: true` with the failures listed. If every one failed, the command fails with `upstream_error` and still carries both lists. Redeemed value lands in the Polymarket wallet as pUSD. Use `withdraw` to move it out. If the output has `truncated: true`, run `redeem --all` again.

## Reporting

```bash
agent polymarket activity [--limit <n>] [--cursor <c>]   # trades, redemptions, transfers; page with nextCursor
agent polymarket pnl [--interval 1d|1w|1m|max]            # valueUsd, realized, unrealized, points
```

## Error codes

| Code | Meaning and fix |
| --- | --- |
| `not_set_up` | No Polymarket account for this wallet. Run `agent polymarket setup --wallet <name> --broadcast`. |
| `below_bridge_minimum` | Deposit is under $2. Use $2 or more. |
| `insufficient_pusd` | Not enough pUSD in the Polymarket wallet. Deposit more, or lower the amount. |
| `insufficient_shares` | You hold fewer shares than asked, or none. Check `positions`. |
| `bridge_pending` | An earlier deposit is not credited yet. Run `status`. Do not retry the deposit. |
| `region_blocked` | Polymarket is not available from this region. `setup`, `deposit`, `withdraw`, `buy`, `sell` and `redeem` fail. Stop. |
| `region_close_only` | This region can only close positions. Use `sell`, `cancel`, `redeem` or `withdraw`. |
| `price_guard` | The estimated fill is worse than `--max-price` or `--min-price`. Check `details.estimatedPrice`, then loosen the guard, use a limit order, or skip. |
| `outcome_not_found` | The outcome or market was not found. Use a name from `details.choices`, or check the slug. |
| `ambiguous_market` | The name matches several outcomes. Pick one from `details.choices`. |
| `order_rejected` | The exchange refused the order. Read `details.venueCode` and the message. |
| `market_not_accepting_orders` | The market is closed or paused. Pick another market. |
| `offset_removed` | `--offset` no longer exists. Use `--cursor` with the previous `nextCursor`. |

An order rejected with "allowance ... spender 0xd91E..." (a neg-risk market) means the legacy NegRiskAdapter approval is missing. Run `agent polymarket setup --wallet <name> --broadcast` again.

General codes you will also see: `invalid_input` (bad amount or flags, including more than 6 decimals), `insufficient_balance` (OMS wallet short of USDC, or of a fee token for the relayer), `wallet_busy` (another deposit for this wallet is still running), `upstream_error`, `upstream_unavailable`, `rate_limited`, and the session codes (`allowance_exhausted`, `session_expired`, `not_connected`). Rate limits and upstream outages are safe to retry after a short wait, except for `deposit` (see the rules).

## Rules for agents

- Always dry-run first, then broadcast.
- Never retry a `deposit` after `bridge_pending` or an interrupted run without checking `status`.
- Never use `--again` unless the user asks.
- Before broadcasting a buy above $10, show the user the dry run's `estimatedPrice` and `estimatedShares` and get a yes.
- Always pass `--max-price` on market buys and `--min-price` on market sells.
- Never print, ask for, or store a private key. The CLI keeps the trading key encrypted on disk.
- Don't build a Polymarket wallet address yourself. Use the `polymarketWallet` and `account.wallet` values the CLI prints.

## Legacy

Accounts that traded through an older Polymarket proxy wallet can attach it:

```bash
agent polymarket import-key <privateKey>
```

This stores the key encrypted as a legacy proxy account and mints the builder key that `withdraw` needs. If minting fails, the import still succeeds and the output has a `warning`. Run `agent polymarket setup --wallet <name> --broadcast` to mint it before withdrawing. Then `withdraw all --broadcast` drains the proxy's pUSD to the OMS wallet. USDC.e left in a legacy proxy is not moved by `withdraw`. New users should use `setup` instead. The old names `clob-buy`, `proxy-wallet`, `approve` and `set-key` still work as hidden aliases for one release.
