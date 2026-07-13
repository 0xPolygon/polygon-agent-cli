---
name: polygon-defi
description: DeFi operations on Polygon using the Polygon Agent CLI. Covers same-chain token swaps, cross-chain bridging, and yield deposits into Aave v3 and Morpho vaults via Trails earn pool discovery. All commands dry-run by default — add --broadcast to execute.
---

# Polygon DeFi Skill

## Session Prerequisites

**Before any DeFi operation, the wallet must be logged in.** The embedded wallet can call any contract and spend any amount it holds — there is no contract whitelist and no per-token spend limit, so no special setup is needed for deposits, swaps, or withdrawals. If the user is not logged in, log in now:

```bash
polygon-agent wallet login
```

This opens the agentconnect login page in the browser; choose Google or email, and once you sign in the embedded wallet is created or unlocked. This works whether the browser is local or remote, so no extra flags are needed on headless hosts. The wallet address is the same across all chains. Sessions last about a week; if calls start failing with an expired-session error, just re-run `wallet login`.

---

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

No API key is required for this public endpoint (an optional `TRAILS_API_KEY` can be set for higher rate limits).

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

Pool discovery uses `TrailsApi.getEarnPools` — picks the most liquid pool (highest TVL) for the asset on the requested chain. No hardcoded addresses — the pool is resolved at runtime. Supported chains: Polygon, Base, Arbitrum, Optimism, Ethereum mainnet (any chain Trails indexes).

**Gas requirement:** The relayer pays gas in USDC or POL, whichever the wallet can afford — so the only requirement is that the wallet holds the funds being deposited plus a little POL or USDC for gas. The CLI always reserves 0.1 USDC for gas — never deposit the full balance. If the requested amount would leave less than 0.1 USDC, the CLI auto-reduces the deposit and prints a note.

The embedded wallet can call any contract, so deposits work without pre-authorizing the token or pool contract — just dry-run, then broadcast:

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

The embedded wallet can call the pool or vault on any chain, so no contract authorization is needed — just make sure the wallet holds a little POL or USDC on that chain for gas. To withdraw on a chain other than Polygon, pass `--chain mainnet` (or another supported chain) on the `withdraw` command itself.

---

## Full DeFi Flow Example

```bash
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

## Arbitrary Contract Calls

For any operation not covered by the dedicated commands, use `call` to send a raw transaction to any contract (the embedded wallet can call anything):

```bash
# Dry-run an arbitrary call
polygon-agent call --to 0x... --data 0x...

# With an attached native value, then broadcast
polygon-agent call --to 0x... --data 0x... --value 0.1 --broadcast

# For a native-only wallet, force the relayer to take its fee in POL
polygon-agent call --to 0x... --data 0x... --prefer-native-fee --broadcast
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Not logged in` / no wallet found | No active wallet session | Run `polygon-agent wallet login` |
| Session expired | Sessions last about a week | Run `polygon-agent wallet login` |
| `Insufficient <token>: wallet has X` | Balance too low for the requested deposit amount | Run `polygon-agent balances` and adjust `--amount` |
| `Unable to pay gas` / `Wallet has no POL for gas` | Wallet can't cover the relayer fee in USDC or POL | Fund the wallet with a little POL or USDC; for a native-only wallet, pass `--prefer-native-fee` on `call` |
| `Protocol X not yet supported` | Trails returned a protocol other than aave/morpho | Use `polygon-agent swap` to obtain the yield-bearing token manually |
| `swap`: no route found | Insufficient liquidity for the pair | Try a different amount or token pair |
