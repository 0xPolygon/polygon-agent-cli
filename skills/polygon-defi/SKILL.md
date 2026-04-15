---
name: polygon-defi
description: DeFi operations on Polygon using the Polygon Agent CLI. Covers same-chain token swaps, cross-chain bridging, and yield deposits into Aave v3 and Morpho vaults via Trails earn pool discovery. Uses the Trails skill for cross-chain swap/bridge/earn flows. Requires a Trails API key — get one at https://dashboard.trails.build. All commands dry-run by default — add --broadcast to execute.
---

# Polygon DeFi Skill

> **Trails Integration**: Swaps, bridges, and earn pool discovery are all powered by [Trails](https://trails.build). This skill uses the `TRAILS_ACCESS_KEY` environment variable (auto-loaded by the CLI from `~/.polygon-agent/builder.json`). For direct Widget, SDK, or API integration, load the `trails` skill. Get your API key at [https://dashboard.trails.build](https://dashboard.trails.build).

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
  --header "X-Access-Key: $TRAILS_ACCESS_KEY" \
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

The API key is available as `TRAILS_ACCESS_KEY` (auto-loaded by the CLI; get one at [https://dashboard.trails.build](https://dashboard.trails.build)).

```typescript
const res = await fetch('https://trails-api.sequence.app/rpc/Trails/GetEarnPools', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Access-Key': process.env.TRAILS_ACCESS_KEY!,
  },
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

### Session Whitelisting

If the deposit is rejected with a session permission error, the pool's contract address needs to be whitelisted when creating the wallet session:

```bash
# 1. Dry-run first to get the depositAddress
polygon-agent deposit --asset USDC --amount 0.3
# → note the depositAddress in output

# 2. Re-create wallet session with that contract whitelisted
polygon-agent wallet create --contract <depositAddress>

# 3. Retry
polygon-agent deposit --asset USDC --amount 0.3 --broadcast
```

When creating a wallet specifically for yield, add `--contract` flags for all intended vaults upfront and omit `--usdc-limit`:

```bash
polygon-agent wallet create \
  --contract 0x794a61358d6845594f94dc1db02a252b5b4814ad \
  --contract 0x781fb7f6d845e3be129289833b04d43aa8558c42
```

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
| `Deposit session rejected` | Pool contract not whitelisted in session | Re-create wallet with `--contract <depositAddress>` |
| `Protocol X not yet supported` | Trails returned a protocol other than aave/morpho | Use `polygon-agent swap` to obtain the yield-bearing token manually |
| `Fee option errors` | Wallet has insufficient balance | Run `polygon-agent balances` and fund the wallet |
| `swap`: no route found | Insufficient liquidity for the pair | Try a different amount or token pair |
