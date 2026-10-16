# Earn: yield deposits and withdrawals

**When to use:** the user wants to earn on their money: find a yield pool, deposit into Aave or a Morpho / ERC-4626 vault, or withdraw from one. For swaps and bridges, read [trade](trade.md).

**Before you start:** yield `deposit`, `withdraw` and `call` need the wallet owner. An allowance install (the assistant default) fails with `owner_required`: tell the user, and don't look for a way around it. You can still look up pools and rates for them. A developer can use owner mode (`agent wallet login --owner`, see [developer](developer.md)). Commands below are written `agent …`: run them as `"$POLYGON_AGENT" …`.

## Query Earn Pools

Use `getEarnPools` to discover live yield opportunities across protocols before deciding where to deposit.

### HTTP

```bash
curl --request POST \
  --url https://trails-api.sequence.app/rpc/Trails/GetEarnPools \
  --header 'Content-Type: application/json' \
  --header "X-Access-Key: $TRAILS_API_KEY" \
  --data '{"chainIds": [137]}'
```

All request fields are optional — omit any you don't need to filter on.

| Field | Type | Description |
|-------|------|-------------|
| `chainIds` | `number[]` | Filter by chain (e.g. `[137]` for Polygon mainnet) |
| `protocols` | `string[]` | Filter by protocol name, e.g. `["Aave"]`, `["Morpho"]` |
| `minTvl` | `number` | Minimum TVL in USD |
| `maxApy` | `number` | Maximum APY (useful to exclude outlier/at-risk pools) |

### API key

Trails officially requires an API key on every request, passed as an `X-Access-Key` header (get one at https://dashboard.trails.build; rate limits are per key: 50 requests/s, burst 100, 20 QuoteIntent/min). `GetEarnPools` currently answers without a key, but do not rely on that.

You normally do not need to set anything: the CLI resolves the key automatically as `TRAILS_API_KEY`, else the Sequence access key stored by `agent setup` (in `builder.json`), which Trails accepts. Set `TRAILS_API_KEY` only to use a dedicated Trails key.

### Fetch (agent code)

```typescript
const res = await fetch('https://trails-api.sequence.app/rpc/Trails/GetEarnPools', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Access-Key': process.env.TRAILS_API_KEY ?? ''
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

### Current Trails earn surface (Yield API)

`GetEarnPools` is the endpoint the CLI's `deposit` command uses today and it remains live, but Trails' current generation earn surface is the **Yield API** at the same base URL: `YieldGetMarkets`, `YieldGetProviders`, `YieldCreateEnterAction`, `YieldCreateExitAction`, and `YieldGetAggregateBalances` (docs: https://docs.trails.build). Query `YieldGetMarkets` when you need markets beyond the Aave and Morpho pools that `GetEarnPools` returns:

```bash
curl --request POST \
  --url https://trails-api.sequence.app/rpc/Trails/YieldGetMarkets \
  --header 'Content-Type: application/json' \
  --header "X-Access-Key: $TRAILS_API_KEY" \
  --data '{}'
```

The response is `{ items: [...] }` with per-market `inputTokens`, provider, and network fields. Note that Trails' intent protocol is now v1.5 (HydrateProxy executor); the API still serves the v1 flow that `agent swap` uses, so existing commands are unaffected.

---

## Deposit to Earn Yield

Pool discovery uses `TrailsApi.getEarnPools` — picks the most liquid pool (highest TVL) for the asset on the requested chain. No hardcoded addresses — the pool is resolved at runtime. Supported chains: Polygon, Base, Arbitrum, Optimism, Ethereum mainnet (any chain Trails indexes).

**Gas requirement:** The relayer pays gas in USDC or POL, whichever the wallet can afford — so the only requirement is that the wallet holds the funds being deposited plus a little POL or USDC for gas. The CLI always reserves 0.1 USDC for gas — never deposit the full balance. If the requested amount would leave less than 0.1 USDC, the CLI auto-reduces the deposit and prints a note.

The embedded wallet can call any contract, so deposits work without pre-authorizing the token or pool contract — just dry-run, then broadcast:

```bash
# Dry-run — shows pool name, APY, TVL, and deposit address before committing
agent deposit --asset USDC --amount 0.3

# Execute — deposits into the highest-TVL active pool
agent deposit --asset USDC --amount 0.3 --broadcast

# Filter by protocol
agent deposit --asset USDC --amount 0.3 --protocol aave --broadcast
agent deposit --asset USDC --amount 0.3 --protocol morpho --broadcast
```

### Dashboard earn vaults (Katana)

The dashboard's Earn tab offers three Morpho stablecoin vaults on Katana, named by risk: **Prime** (most established, lowest risk), **Frontier**, and **Advanced** (smallest, highest risk). It assigns them live by size from the Trails Yield API, so the vault behind each name can change. When the user asks to deposit into one, the dashboard prompt includes the vault address. Use it with `--vault`:

```bash
# 1. If the USDC is on Polygon, bridge it to Katana first (dry-run, then --broadcast)
agent swap --from USDC --to USDC --amount 100 --to-chain katana

# 2. Deposit into that exact vault (dry-run, then --broadcast)
agent deposit --chain katana --asset USDC --amount 100 --vault <vault address>
```

`--vault` checks that the vault takes the `--asset` token and refuses otherwise. Tell the user the tier name (Prime, Frontier, or Advanced) and the rate; don't name the vault's curator or underlying markets.

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
agent withdraw --position 0x68215b6533c47ff9f7125ac95adf00fe4a62f79e --amount max --chain mainnet

# Partial Aave withdraw (underlying units, e.g. USDC)
agent withdraw --position <aToken> --amount 0.5 --chain mainnet --broadcast

# ERC-4626: max redeems all shares; partial amount is underlying units (convertToShares)
agent withdraw --position <vault> --amount max --chain polygon --broadcast
```

The embedded wallet can call the pool or vault on any chain, so no contract authorization is needed — just make sure the wallet holds a little POL or USDC on that chain for gas. To withdraw on a chain other than Polygon, pass `--chain mainnet` (or another supported chain) on the `withdraw` command itself.

---

## Full DeFi Flow Example

```bash
# 1. Check balances
agent balances

# 2. Swap POL → USDC
agent swap --from POL --to USDC --amount 1 --broadcast

# 3. Deposit USDC into highest-TVL yield pool
agent deposit --asset USDC --amount 1 --broadcast
# → protocol: morpho (or aave, whichever has highest TVL at the time)
# → poolApy shown in dry-run output

# 4. Bridge remaining USDC to Arbitrum
agent swap --from USDC --to USDC --amount 0.5 --to-chain arbitrum --broadcast
```

---

## Arbitrary Contract Calls

For any operation not covered by the dedicated commands, use `call` to send a raw transaction to any contract (the embedded wallet can call anything):

```bash
# Dry-run an arbitrary call
agent call --to 0x... --data 0x...

# With an attached native value, then broadcast
agent call --to 0x... --data 0x... --value 0.1 --broadcast

# For a native-only wallet, force the relayer to take its fee in POL
agent call --to 0x... --data 0x... --prefer-native-fee --broadcast
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `Not logged in` / no wallet found | No wallet yet | Run `agent wallet login` |
| Owner-mode session expired | Sessions last about a week | Run `agent wallet login --owner` |
| `owner_required` on `deposit` or `withdraw` | This install connected with an allowance (session mode) | Yield needs the owner. Tell the user; a developer can use `agent wallet login --owner` |
| `Insufficient <token>: wallet has X` | Balance too low for the requested deposit amount | Run `agent balances` and adjust `--amount` |
| `Unable to pay gas` / `Wallet has no POL for gas` | Wallet can't cover the relayer fee in USDC or POL | Fund the wallet with a little POL or USDC; for a native-only wallet, pass `--prefer-native-fee` on `call` |
| `Protocol X not yet supported` | Trails returned a protocol other than aave/morpho | Use `agent swap` to obtain the yield-bearing token manually |
| `swap`: no route found | Insufficient liquidity for the pair | Try a different amount or token pair |
