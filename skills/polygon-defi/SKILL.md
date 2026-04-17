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
  apy:                         number;  // annualised yield as a decimal percent
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

Pool discovery uses `TrailsApi.getEarnPools` — picks the most liquid pool (highest TVL) for the asset on the current chain. No hardcoded addresses — the pool is resolved at runtime.

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

Whitelist the **pool** (Aave) or **vault** contract on the session if the wallet rejects the call (`polygon-agent wallet create --contract <poolOrVault>`).

**Same chain as the transaction:** if you use `withdraw --chain mainnet`, create or refresh the session with **`wallet create --chain mainnet`** (not only Polygon defaults). Include **`--contract`** for the **pool** and for the **underlying ERC-20** on that chain (e.g. mainnet USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`) so fee / helper transfers are allowed. Tight **`--usdc-limit`** can block those — omit or relax for yield exits.

### Session Whitelisting

A deposit sends **two transactions**: an ERC-20 `approve()` on the token contract, then the pool deposit call. Both contracts must be whitelisted in the session. If the deposit is rejected with a session permission error:

```bash
# 1. Dry-run first — output includes both addresses under `transactions[0].to` (token) and `depositAddress` (pool)
polygon-agent deposit --asset USDC --amount 0.3
# → note the token contract address (e.g. USDC: 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359)
# → note the depositAddress (e.g. Aave V3: 0x794a61358d6845594f94dc1db02a252b5b4814ad)

# 2. Re-create wallet session with BOTH contracts whitelisted
polygon-agent wallet create --contract <tokenAddress> --contract <depositAddress>

# 3. Retry
polygon-agent deposit --asset USDC --amount 0.3 --broadcast
```

Common token contracts on Polygon mainnet (already auto-whitelisted in sessions created by the CLI):
- USDC: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- USDT: `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`
- WETH: `0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619`

### Yield Vault Contract Whitelist

#### Polygon Mainnet (chainId 137)

| Protocol | Asset | Address |
|----------|-------|---------|
| Aave V3 Pool (all markets) | USDC, USDT, WETH, WMATIC… | `0x794a61358d6845594f94dc1db02a252b5b4814ad` |
| Morpho Compound USDC | USDC | `0x781fb7f6d845e3be129289833b04d43aa8558c42` |
| Morpho Compound WETH | WETH | `0xf5c81d25ee174d83f1fd202ca94ae6070d073ccf` |
| Morpho Compound POL | POL | `0x3f33f9f7e2d7cfbcbdf8ea8b870a6e3d449664c2` |

#### Katana (chainId 747474) — Morpho Vaults

| Vault | Asset | TVL | Address |
|-------|-------|-----|---------|
| Gauntlet USDT | USDT | ~$97M | `0x1ecdc3f2b5e90bfb55ff45a7476ff98a8957388e` |
| Steakhouse Prime USDC | USDC | ~$54M | `0x61d4f9d3797ba4da152238c53a6f93fb665c3c1d` |
| Yearn OG ETH | WETH | ~$16M | `0xfade0c546f44e33c134c4036207b314ac643dc2e` |
| Yearn OG USDC | USDC | ~$16M | `0xce2b8e464fc7b5e58710c24b7e5ebfb6027f29d7` |
| Gauntlet USDC | USDC | ~$8M | `0xe4248e2105508fcbad3fe95691551d1af14015f7` |
| Yearn OG USDT | USDT | ~$8M | `0x8ed68f91afbe5871dce31ae007a936ebe8511d47` |
| Gauntlet WETH | WETH | ~$6M | `0xc5e7ab07030305fc925175b25b93b285d40dcdff` |
| Hyperithm vbUSDC Apex | USDC | ~$3M | `0xef77f8c53af95f3348cee0fb2a02ee02ab9cdca5` |

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

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Deposit session rejected` | Pool or token contract not whitelisted | Re-create wallet with `--contract <tokenAddress> --contract <depositAddress>` (both required) |
| `Protocol X not yet supported` | Trails returned a protocol other than aave/morpho | Use `polygon-agent swap` to obtain the yield-bearing token manually |
| `Fee option errors` | Wallet has insufficient balance | Run `polygon-agent balances` and fund the wallet |
| `swap`: no route found | Insufficient liquidity for the pair | Try a different amount or token pair |
