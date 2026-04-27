---
name: polygon-defi
description: DeFi operations on Polygon using the Polygon Agent CLI. Covers same-chain token swaps, cross-chain bridging, and yield deposits into Aave v3 and Morpho vaults via Trails earn pool discovery. All commands dry-run by default — add --broadcast to execute.
---

# Polygon DeFi Skill

## Swap Tokens (Same-Chain)

```bash
# Dry-run — shows route and output amount
polygon-agent swap --from USDC --to USDT --amount 5

# Execute
polygon-agent swap --from USDC --to USDT --amount 5 --broadcast

# Custom slippage (default 0.5%)
polygon-agent swap --from USDC --to USDT --amount 5 --slippage 0.005 --broadcast
```

## Bridge Tokens (Cross-Chain)

```bash
# Bridge USDC from Polygon to Arbitrum
polygon-agent swap --from USDC --to USDC --amount 0.5 --to-chain arbitrum --broadcast

# Bridge to other supported chains
polygon-agent swap --from USDC --to USDC --amount 1 --to-chain optimism --broadcast
polygon-agent swap --from USDC --to USDC --amount 1 --to-chain base --broadcast
polygon-agent swap --from USDC --to USDC --amount 1 --to-chain mainnet --broadcast
```

Valid `--to-chain` values: `polygon`, `amoy`, `mainnet`, `arbitrum`, `optimism`, `base`.

## Query Earn Pools

Use `getEarnPools` to discover live yield opportunities across protocols before deciding where to deposit.

### HTTP

```bash
curl --request POST \
  --url https://trails-api.sequence.app/rpc/Trails/GetEarnPools \
  --header 'Content-Type: application/json' \
  --data '{"chainIds": [137]}'
```

All request fields are optional — omit any you don't need to filter on.

| Field | Type | Description |
|-------|------|-------------|
| `chainIds` | `number[]` | Filter by chain (e.g. `[137]` for Polygon mainnet) |
| `protocols` | `string[]` | Filter by protocol name, e.g. `["Aave"]`, `["Morpho"]` |
| `minTvl` | `number` | Minimum TVL in USD |
| `maxApy` | `number` | Maximum APY (useful to exclude outlier/at-risk pools) |

### Fetch (agent code)

The API key is the project access key already available to the agent (`SEQUENCE_PROJECT_ACCESS_KEY`).

```typescript
const res = await fetch('https://trails-api.sequence.app/rpc/Trails/GetEarnPools', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chainIds: [137] }),
});
const { pools } = await res.json();
```

### Response Schema

```typescript
interface GetEarnPoolsResponse {
  pools:     EarnPool[];
  timestamp: string;   // ISO-8601 fetch time
  cached:    boolean;
}

interface EarnPool {
  id:                          string;  // "{protocol}-{chainId}-{address}"
  name:                        string;  // e.g. "USDC Market"
  protocol:                    string;  // "Aave" | "Morpho"
  chainId:                     number;
  apy:                         number;  // annualised yield as a percentage (e.g. 2.8 = 2.8% APY — NOT a decimal fraction)
  tvl:                         number;  // USD
  token:                       PoolTokenInfo;
  depositAddress:              string;  // contract to approve/send to
  isActive:                    boolean;
  poolUrl?:                    string;
  protocolUrl?:                string;
  wrappedTokenGatewayAddress?: string; // non-null for Aave native-token markets
}

interface PoolTokenInfo {
  symbol:   string;
  name:     string;
  address:  string;
  decimals: number;
  logoUrl?: string;
}
```

> **Tip:** `wrappedTokenGatewayAddress` is set on Aave markets that accept a wrapped native token (WPOL, WETH). Pass this address instead of `depositAddress` when depositing POL/ETH directly.

---

## Deposit to Earn Yield

Pool discovery uses `TrailsApi.getEarnPools` — picks the most liquid pool (highest TVL) for the asset. Only Polygon mainnet (chainId 137) is supported. No hardcoded addresses — the pool is resolved at runtime.

**Gas requirement:** The wallet needs POL for gas, or a session created with `--usdc-limit` to enable USDC paymaster. If the wallet has no POL, create the session with `--usdc-limit 5`. When USDC paymaster is active and the deposit amount would consume the full balance, the CLI auto-reserves 0.05 USDC for gas and prints a note.

```bash
# Dry-run — shows pool name, APY, TVL, and deposit address before committing
polygon-agent deposit --asset USDC --amount 0.3

# Execute — deposits into the highest-TVL active pool
polygon-agent deposit --asset USDC --amount 0.3 --broadcast

# Filter by protocol
polygon-agent deposit --asset USDC --amount 0.3 --protocol aave --broadcast
polygon-agent deposit --asset USDC --amount 0.3 --protocol morpho --broadcast
```

### Supported Protocols

| Protocol | Encoding | Description |
|----------|----------|-------------|
| **Aave v3** | `supply(asset, amount, onBehalfOf, referralCode)` | Lending pool deposit |
| **Morpho** | `deposit(assets, receiver)` — ERC-4626 | Vault deposit |

Vault/pool addresses are resolved dynamically from Trails — they are not hardcoded. The dry-run output includes `depositAddress` so you can inspect the exact contract before broadcasting.

## Withdraw (Aave aToken or ERC-4626 vault)

Pass the **position token** you hold: an **Aave aToken** address, or a **Morpho / ERC-4626 vault** (share) address. The CLI resolves the Aave **Pool** via `POOL()` on the aToken, or uses `redeem` on the vault. Dry-run by default.

```bash
# Full exit from an Aave position (aToken from balances output)
polygon-agent withdraw --position 0x68215b6533c47ff9f7125ac95adf00fe4a62f79e --amount max --chain mainnet

# Partial Aave withdraw (underlying units, e.g. USDC)
polygon-agent withdraw --position <aToken> --amount 0.5 --chain mainnet --broadcast

# ERC-4626: max redeems all shares; partial amount is underlying units (convertToShares)
polygon-agent withdraw --position <vault> --amount max --chain polygon --broadcast
```

### Session Prerequisites for DeFi

Before running deposits, swaps, or withdrawals, create the wallet session with `--defi` so the relevant token and vault contracts are whitelisted:

```bash
polygon-agent wallet create --defi
```

Without `--defi`, only USDC and USDC.e are whitelisted by default. The `--defi` flag adds USDT, WETH, and all supported yield vault addresses (Aave and Morpho on Polygon mainnet).

**Same chain as the transaction:** if you use `withdraw --chain mainnet`, create or refresh the session with **`wallet create --chain mainnet --defi`**. Include **`--contract`** for the **underlying ERC-20** on that chain (e.g. mainnet USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) since `--defi` only covers Polygon mainnet contracts. Tight **`--usdc-limit`** can block fee/helper transfers — omit or relax for yield exits.

### Session Whitelisting

A deposit sends **two transactions**: an ERC-20 `approve()` on the token contract, then the pool deposit call. Both contracts must be whitelisted in the session. If the deposit is rejected with a session permission error:

```bash
# 1. Dry-run first — output includes both addresses under `transactions[0].to` (token) and `depositAddress` (pool)
polygon-agent deposit --asset USDC --amount 0.3
# → note the token contract address (e.g. USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)
# → note the depositAddress (e.g. Aave V3: 0x794a61358d6845594f94dc1db02a252b5b4814ad)

# 2. Re-create wallet session with DeFi contracts whitelisted (covers both token and vault)
polygon-agent wallet create --defi

# 3. Retry
polygon-agent deposit --asset USDC --amount 0.3 --broadcast
```

To add a contract not covered by `--defi`, use `--contract` alongside it:

```bash
polygon-agent wallet create --defi --contract <extraAddress>
```

### Yield Vault Contract Whitelist

The following contracts are included when `--defi` is passed:

#### Polygon Mainnet (chainId 137)

| Protocol | Asset | Address |
|----------|-------|---------|
| Aave V3 Pool (all markets) | USDC, USDT, WETH, WMATIC… | `0x794a61358d6845594f94dc1db02a252b5b4814ad` |
| Morpho Compound USDC | USDC | `0x781fb7f6d845e3be129289833b04d43aa8558c42` |
| Morpho Compound WETH | WETH | `0xf5c81d25ee174d83f1fd202ca94ae6070d073ccf` |
| Morpho Compound POL | POL | `0x3f33f9f7e2d7cfbcbdf8ea8b870a6e3d449664c2` |

---

## Full DeFi Flow Example

```bash
# 0. Create session with DeFi contracts whitelisted
polygon-agent wallet create --defi --usdc-limit 5

# 1. Check balances
polygon-agent balances

# 2. Swap POL → USDC
polygon-agent swap --from POL --to USDC --amount 1 --broadcast

# 3. Deposit USDC into highest-TVL yield pool
polygon-agent deposit --asset USDC --amount 1 --broadcast
# → protocol: morpho (or aave, whichever has highest TVL at the time)
# → poolApy shown in dry-run output

# 4. Bridge remaining USDC to Arbitrum
polygon-agent swap --from USDC --to USDC --amount 0.5 --to-chain arbitrum --broadcast
```

---

## wallet create — Key Options

| Flag | Purpose |
|------|---------|
| `--defi` | Whitelist DeFi contracts (USDT, WETH, yield vaults on Polygon mainnet). Required for swaps and deposits. |
| `--usdc-limit <amt>` | Enable USDC gas paymaster. Required when the wallet has no POL. Recommended: `--usdc-limit 5`. |
| `--force` | Replace an existing session without prompting. By default, re-creating a session is blocked if one already exists — the old wallet balance is not accessible from a new session. |
| `--contract <addr>` | Whitelist an additional contract (repeatable). Use this if a deposit is rejected due to a missing contract permission. |

```bash
# New session for DeFi operations (swaps, deposits) with USDC gas paymaster
polygon-agent wallet create --defi --usdc-limit 5

# Replace an existing session
polygon-agent wallet create --defi --force --usdc-limit 5
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Insufficient <token>: wallet has X` | Balance too low for the requested deposit amount | Run `polygon-agent balances` and adjust `--amount` |
| `Wallet has no POL for gas` | No native gas and no USDC paymaster | Fund with POL (`polygon-agent fund`) or re-create session with `--usdc-limit 5` |
| `Transaction rejected by relay` | Session permissions missing for pool or token contract | Re-create with `--defi` or add `--contract <addr>` for a specific address |
| `Unable to pay gas` | No usable fee token found | Fund with POL or add `--usdc-limit 5` to session |
| `Wallet already exists` | Re-creating would orphan the old session | Use `--force` only after confirming old wallet funds are swept or unneeded |
| `Protocol X not yet supported` | Trails returned a protocol other than aave/morpho | Use `polygon-agent swap` to obtain the yield-bearing token manually |
| `swap`: no route found | Insufficient liquidity for the pair | Try a different amount or token pair |
