---
name: polymarket-skill
description: Place bets on Polymarket prediction markets using the Polygon Agent CLI. Browse markets, check prices, buy YES/NO positions, sell positions, manage orders. All commands are JSON output. Dry-run by default — always add --broadcast to execute.
---

# Polymarket Skill

## Session Initialization

Before any polymarket command, initialize the session. Read `~/.polygon-agent/builder.json` and export the access key:

```bash
export SEQUENCE_PROJECT_ACCESS_KEY=<accessKey from builder.json>
export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
```

Also verify the Polymarket key is set:
```bash
polygon-agent polymarket proxy-wallet
```
If this returns `ok: true` with an `eoaAddress` and `proxyWalletAddress`, the key is configured. If it errors, the user needs to run `set-key` (see Onboarding below).

---

## Understanding the 3 Addresses

Every Polymarket user has three addresses. Do not confuse them:

| Name | What it is | Used for |
|------|-----------|---------|
| EOA | Private key owner. Shown as `eoaAddress` in CLI output | Signs transactions and CLOB orders. Holds POL for gas |
| Proxy Wallet | Shown as `proxyWalletAddress` in CLI output. This is what Polymarket shows as "your address" in the UI | Holds USDC.e and outcome tokens. The CLOB `maker` |
| Deposit Address | A cross-chain bridge ingress — only relevant for bridging from other chains | Ignore for Polygon-native usage |

**For trading:** funds go from the Sequence smart wallet → proxy wallet → CLOB orders. The proxy wallet is the trading identity.

---

## Onboarding: First-Time Setup

### Option A — Using email login (Polymarket account)

If the user has a Polymarket account via email login:

**Step 1: Get the private key from Polymarket**
```
1. Go to: https://reveal.magic.link/polymarket
2. Connect/authenticate with the same email used for Polymarket
3. Copy the exported private key (0x...)
```

**Step 2: Accept Terms of Service**
```
1. Go to: https://polymarket.com
2. Connect wallet using the exported private key (import to MetaMask or similar)
3. Accept Terms of Service when prompted
   — This is REQUIRED for CLOB order placement. Without it, orders will fail.
```

**Step 3: Import the key into the CLI**
```bash
polygon-agent polymarket set-key <privateKey>
```
Output confirms the `eoaAddress` and `proxyWalletAddress`.

**Step 3b: Confirm your addresses (show this to the user)**
```bash
polygon-agent polymarket proxy-wallet
```
**Tell the user:** "Your EOA is `<eoaAddress>` — this needs POL for gas. Your Polymarket trading address (proxy wallet) is `<proxyWalletAddress>` — this is where your USDC.e and outcome tokens live. The proxy wallet does not need POL. You must fund the EOA with POL and run approvals before trading."

**Step 4: Fund the EOA with POL for gas**
```bash
# Check EOA address from set-key output, then send ~0.1 POL to it
polygon-agent send-native --to <eoaAddress> --amount 0.1 --broadcast
```

**Step 5: Set proxy wallet approvals (one-time, permanent)**
```bash
polygon-agent polymarket approve --broadcast
```
This sends a transaction directly from the EOA (not through Polymarket's UI), so the EOA must hold POL for gas. This is different from trading on polymarket.com, where their UI sponsors gas for you.

### Option B — Using the builder EOA (no Polymarket account needed)

If the user has done `polygon-agent setup` already, the builder EOA can be used directly. Skip `set-key`.

**Step 1: Confirm addresses (show this to the user)**
```bash
polygon-agent polymarket proxy-wallet
```
**Tell the user:** "Your EOA is `<eoaAddress>` — this needs POL for gas. Your Polymarket trading address (proxy wallet) is `<proxyWalletAddress>` — this is where your USDC.e and outcome tokens live. The proxy wallet does not need POL. You must accept Polymarket ToS, fund the EOA with POL, and run approvals before trading."

**Step 2: Accept Terms of Service (required — CLOB orders will fail without this)**
```
1. Go to https://polymarket.com
2. Connect with the EOA wallet address shown above
3. Accept Terms of Service when prompted
```

**Step 3: Fund the EOA with POL for gas**
```bash
polygon-agent send-native --to <eoaAddress> --amount 0.1 --broadcast
```

**Step 4: Set proxy wallet approvals (one-time)**
```bash
polygon-agent polymarket approve --broadcast
```
This sends a transaction directly from the EOA (not through Polymarket's UI), so the EOA must hold POL for gas.

---

## Commands

### Browse Markets

```bash
# List top markets by volume
polygon-agent polymarket markets

# Search by keyword
polygon-agent polymarket markets --search "bitcoin" --limit 10

# Paginate
polygon-agent polymarket markets --limit 20 --offset 20
```

Key output fields per market:
- `conditionId` — the ID needed for all trading commands
- `question` — what the market is asking
- `yesPrice` / `noPrice` — current probability (0 to 1, e.g. `0.65` = 65%)
- `negRisk` — if `true`, set neg-risk approvals before trading this market
- `endDate` — when the market resolves

### Get a Single Market

```bash
polygon-agent polymarket market <conditionId>
```

Use this to confirm prices and token IDs before placing an order.

### Show Proxy Wallet Address

```bash
polygon-agent polymarket proxy-wallet
```

Confirms which EOA and proxy wallet are active. The proxy wallet is where USDC.e and tokens are held.

### Set Approvals (One-Time)

```bash
# Standard markets
polygon-agent polymarket approve --broadcast

# Neg-risk markets (if you see negRisk: true on any market you want to trade)
polygon-agent polymarket approve --neg-risk --broadcast
```

Run once per EOA. Permanent on-chain — no need to repeat unless enabling neg-risk.
**Dry-run (no --broadcast) shows what will be approved without executing.**

### Buy a Position

```bash
# Dry-run first — always check before executing
polygon-agent polymarket clob-buy <conditionId> YES|NO <usdcAmount>

# Execute — funds proxy wallet from smart wallet, then places order
polygon-agent polymarket clob-buy <conditionId> YES|NO <usdcAmount> --broadcast

# If proxy wallet already has USDC.e (skip the funding step)
polygon-agent polymarket clob-buy <conditionId> YES|NO <usdcAmount> --skip-fund --broadcast

# Limit order — fill only at this price or better
polygon-agent polymarket clob-buy <conditionId> YES <usdcAmount> --price 0.45 --broadcast
```

**How it works:**
1. Smart wallet transfers `usdcAmount` USDC.e to the proxy wallet (Sequence tx, USDC.e fee)
2. Posts CLOB BUY order: maker=proxy wallet, signer=EOA (off-chain, no gas)
3. Tokens arrive in proxy wallet on fill

**Order types:**
- No `--price`: FOK market order (fill entirely or cancel)
- `--fak`: FAK market order (partial fills allowed)
- `--price 0.x`: GTC limit order (stays open until filled or cancelled)

**Minimum order size: $1 USDC.** The CLOB rejects marketable BUY orders below $1. If the fund step runs but the order is rejected, the USDC.e stays in the proxy wallet — use `--skip-fund` on the retry.

### Sell a Position

```bash
# Dry-run first
polygon-agent polymarket sell <conditionId> YES|NO <shares>

# Execute
polygon-agent polymarket sell <conditionId> YES|NO <shares> --broadcast

# Limit sell
polygon-agent polymarket sell <conditionId> YES <shares> --price 0.80 --broadcast
```

`<shares>` is the number of outcome tokens (not USD). Get share count from `positions`.
Selling is pure off-chain — no gas, no on-chain tx.

### Check Positions

```bash
polygon-agent polymarket positions
```

Shows all open positions in the proxy wallet with current value, P&L, and outcome.

### Check Open Orders

```bash
polygon-agent polymarket orders
```

Lists GTC limit orders that are still open (FOK/FAK orders are never "open" — they fill or cancel immediately).

### Cancel an Order

```bash
polygon-agent polymarket cancel <orderId>
```

Get `orderId` from the `orders` command or from the `orderId` field in `clob-buy` output.

---

## Full Autonomous Trading Flow

This is the exact sequence to go from zero to a filled trade:

```bash
# ── SETUP (run once per EOA) ────────────────────────────────────────────

# 1. Import your Polymarket private key
#    (get it from https://reveal.magic.link/polymarket after email login)
polygon-agent polymarket set-key 0x<yourPrivateKey>
# → save eoaAddress and proxyWalletAddress from output

# 2. Fund the EOA with POL for gas
polygon-agent send-native --to <eoaAddress> --amount 0.1 --broadcast

# 3. Set proxy wallet approvals (one-time)
polygon-agent polymarket approve --broadcast
# → save approveTxHash, wait for confirmation

# ── FIND A MARKET ────────────────────────────────────────────────────────

# 4. Search for markets
polygon-agent polymarket markets --search "fed rate" --limit 10

# 5. Get details on a specific market
polygon-agent polymarket market 0x<conditionId>
# → check: yesPrice, noPrice, negRisk, endDate
# → if negRisk: true → run approve --neg-risk --broadcast first

# ── ENTER A POSITION ────────────────────────────────────────────────────

# 6. Dry-run to confirm everything
polygon-agent polymarket clob-buy 0x<conditionId> YES 5
# → review: currentPrice, proxyWalletAddress, flow

# 7. Execute
polygon-agent polymarket clob-buy 0x<conditionId> YES 5 --broadcast
# → save orderId, check orderStatus === "matched"

# ── MANAGE ──────────────────────────────────────────────────────────────

# 8. Check your positions
polygon-agent polymarket positions
# → review: size (shares), curPrice, cashPnl, title, outcome

# 9. Sell when ready
polygon-agent polymarket sell 0x<conditionId> YES <shares> --broadcast
# → orderStatus === "matched" means USDC.e is back in proxy wallet
```

---

## Decision Logic for an Autonomous Agent

When deciding whether to buy:
1. Check `positions` — avoid doubling up on already-held positions
2. Check `markets` — use `yesPrice`/`noPrice` as probability inputs
3. Check `negRisk` — if `true`, verify neg-risk approvals were set
4. Check proxy wallet USDC.e balance before buying (use `proxy-wallet` to get address, then check balance externally or via `balances`)
5. Use `--skip-fund` if the proxy wallet already has enough USDC.e from a previous `clob-buy`
6. Always dry-run first, then broadcast

When deciding whether to sell:
1. Get current `size` (shares) from `positions`
2. Use `curPrice` vs `avgPrice` to assess profit/loss
3. Market sell (`sell --broadcast`) for immediate exit
4. Limit sell (`--price 0.x --broadcast`) to wait for a better price

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `No EOA key found` | `set-key` not run | Run `polygon-agent polymarket set-key <pk>` |
| `Could not create api key` (stderr) | ToS not accepted | Visit polymarket.com, connect EOA wallet, accept terms. This error in **stderr** is non-fatal — the CLI retries with `deriveApiKey` and may still succeed. |
| `CLOB order error: not authorized` | ToS not accepted | Same as above — fatal for order posting |
| `insufficient funds for gas` | EOA has no POL | `polygon-agent send-native --to <eoaAddress> --amount 0.1 --broadcast` |
| `execution reverted: must be called be owner` | Old code calling proxy directly | Upgrade CLI — fixed in current version (calls factory) |
| `Market not found` | Low-volume or closed market | Market may have resolved; try `--search` with different terms |
| `Market has no tokenIds` | Closed market | Check `endDate` — market resolved |
| `orderStatus: "unmatched"` on FOK | No liquidity at market price | Try `--fak` for partial fill, or `--price 0.x` for limit order |
| `invalid amount for a marketable BUY order ($X), min size: $1` | Amount below CLOB minimum | Use at least $1. If USDC.e was already funded, retry with `--skip-fund` |
| `Wallet not found: main` | No Sequence wallet | Run `polygon-agent wallet create` |

---

## Key Facts for Agents

- **All commands are dry-run by default.** `approve`, `clob-buy`, `sell` do nothing without `--broadcast`.
- **`clob-buy` transfers USDC.e from the smart wallet to the proxy wallet automatically** (unless `--skip-fund`).
- **Positions live in the proxy wallet**, not the Sequence smart wallet. `positions` queries the proxy wallet.
- **Approvals are one-time.** Don't run `approve` before every trade — only once per EOA (and once more if enabling neg-risk).
- **Sell is free.** No gas, no on-chain tx. Selling via CLOB is a signed off-chain message only.
- **`orderStatus: "matched"`** means the trade filled. `"unmatched"` means FOK failed (no liquidity).
- **The proxy wallet address never changes.** It is deterministic from the EOA via CREATE2.
