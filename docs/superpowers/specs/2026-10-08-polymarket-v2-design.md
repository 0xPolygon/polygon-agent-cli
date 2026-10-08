# Polymarket V2: trading account, funding, and command rewrite

Date: 2026-10-08. Status: draft for review. Branch: `polymarket-v2` (from PR #143), with PR #145 merged in first.

## Goal

An agent with an OMS wallet can trade on Polymarket without the user exporting or importing a private key, without needing POL for gas, and without leaving the OMS wallet as the place money lives. Assistants in session mode (PR #143) can trade within the allowance the owner approved.

Success looks like this run, with no manual steps after `wallet login`:

```bash
agent polymarket setup --broadcast
agent polymarket deposit 10 --broadcast
agent polymarket buy <market> Yes 5 --broadcast
agent polymarket sell <market> Yes all --broadcast
agent polymarket withdraw all --broadcast
```

## What the spike established

Tested live on 2026-10-08. Nothing was funded.

- The OMS wallet's signatures pass the exchange contract's ERC-1271 check, but Polymarket's CLOB rejects the OMS wallet as a trading account:
  - API key creation accepts only EOA signatures ("Invalid L1 Request headers").
  - An order's signer must be the API key's address.
  - Type 3 (contract wallet) orders resolve only Polymarket's registered Deposit Wallets ("no deposit wallet found for owner").
- OMS session keys can't sign messages or typed data (oms-wallet 0.3.1 `RemoteAccessClient`).
- A Polymarket Deposit Wallet can be created entirely in code, free, from a fresh key:
  - `createBuilderApiKey` mints a builder key.
  - `createSecureClient` with that key deploys the wallet through Polymarket's relayer.
  - `setupTradingApprovals` succeeds, gasless.
- Polymarket's Bridge API issues a per-wallet deposit address. Polygon USDC or USDC.e sent there is credited as pUSD, with a $2 minimum. Withdrawals are free: send pUSD to a bridge address tied to a destination token and recipient.

## Design

### Accounts

Each OMS wallet name gets one Polymarket account:

- **Trading key.** A secp256k1 key the CLI generates. It's stored AES-encrypted like other keys, under `$POLYGON_AGENT_HOME/polymarket/<wallet>/`. The user never sees it.
- **Deposit Wallet.** Derived from the trading key and deployed by Polymarket's relayer. It holds pUSD and positions, and it is the account Polymarket shows.
- **Builder API key.** Minted from the trading key and stored encrypted next to it. It authorizes gasless relayer transactions (100 per day on the unverified tier, per key).

The OMS wallet is the treasury: money enters the Deposit Wallet only by `deposit`, and `withdraw` only pays out to the OMS wallet.

**Existing users of `set-key`** (an imported key with a Polymarket proxy wallet) keep working. The SDK accepts a proxy wallet as the account. `status` labels these accounts `legacy-proxy`, and `withdraw` can drain them to the OMS wallet. No positions are migrated.

### SDK

Replace `@polymarket/clob-client-v2`, `@polymarket/sdk` and our hand-rolled proxy-wallet code with `@polymarket/client` (0.12.x, pinned exactly while it's pre-1.0), through its viem `privateKey` signer.

The SDK covers everything listed below except the bridge, which is two plain HTTP calls. It should also cover Polymarket V2 markets (ExchangeV3); that is verified in the live milestone, not assumed.

`lib/polymarket.ts` becomes a thin adapter with four jobs:
- build the secure client for a wallet name
- map SDK errors to `PolymarketError` codes
- normalize output
- run the bridge calls

Commands never call the SDK directly.

### Funding

- **`deposit <usd>`**
  1. Gets the Deposit Wallet's bridge address (`POST bridge.polymarket.com/deposit`).
  2. Sends Polygon USDC from the OMS wallet through `runTx`. It falls back to USDC.e, and otherwise suggests `agent swap` first.
  3. Waits for the bridge to credit pUSD (`/status/{address}`).

  Under $2 it fails with `below_bridge_minimum`. It's a plain token transfer, so in session mode it counts against the allowance like any send.
- **`withdraw <usd|all>`**
  1. Gets a bridge address with destination Polygon USDC and recipient the OMS wallet (`POST /withdraw`).
  2. Sends pUSD from the Deposit Wallet with `transferErc20` (gasless).
  3. Waits for the USDC to arrive.

  The recipient is always the OMS wallet; there is no `--to`.

### Session mode

Polymarket is no longer refused in session mode. The trading key's orders aren't limited by OMS smart sessions, but they can only use money that arrived through `deposit`, which the allowance limits. `wallet status` and the `polygon-oms-wallet` skill state this plainly: *money moved to Polymarket is controlled by the install, not by the allowance*.

### Region checks

`status` and every write call the geoblock endpoint and the CLOB's closed-only flag:

- **Blocked region:** writes fail with `region_blocked`.
- **Close-only region** (the US and others): `buy` fails with `region_close_only`. `sell`, `cancel`, `redeem` and `withdraw` still work.

### Builder code

Orders and bridge calls carry Polygon's builder code when `POLYMARKET_BUILDER_CODE` is set. That gives attribution and makes builder fees possible. The default stays unset until Polygon registers a builder profile at polymarket.com/settings?tab=builder (open item 1).

### Commands

All output is JSON. Writes are dry-run unless `--broadcast` is passed or the transaction mode is `auto`. Errors carry `code`. A market can be given as a condition id or a slug, and an outcome by name (`Yes`, `No`, `Trump`); multi-outcome markets resolve through their event.

| Command | Does | Write |
|---|---|---|
| `setup` | Create the trading key, mint the builder key, deploy the Deposit Wallet, set approvals. Safe to re-run. | yes |
| `status` | Account type and address, pUSD balance, approvals state, region, open orders count, redeemable value | no |
| `deposit <usd>` | OMS wallet → bridge → pUSD | yes |
| `withdraw <usd\|all>` | pUSD → bridge → USDC in the OMS wallet | yes |
| `markets [--search] [--tag] [--cursor]` | Discover markets (from #145) | no |
| `event <slug>` | An event and all its outcome markets | no |
| `market <id\|slug>` | One market, with best bid, ask and spread per outcome | no |
| `book <market> <outcome>` | Order book depth | no |
| `history <market> <outcome> [--interval]` | Price history | no |
| `buy <market> <outcome> <usd> [--max-price \| --price] [--expires]` | Market buy, with an optional worst-price guard (`estimateMarketPrice` checked before posting), or a limit order | yes |
| `sell <market> <outcome> <shares\|all> [--min-price \| --price] [--expires]` | Market or limit sell | yes |
| `orders`, `cancel <id>`, `cancel --all [--market]` | Manage open orders | cancel: yes |
| `positions [--status]` | From #145 | no |
| `redeem [<market>\|--all]` | Redeem resolved positions | yes |
| `activity [--cursor]`, `pnl [--interval]` | Trade history and P&L (Data API v2) | no |

Removed: `clob-buy`, `proxy-wallet`, `approve` and `set-key`. They stay as hidden aliases for one release: `clob-buy` → `buy`, `proxy-wallet` → `status`, `approve` → `setup`, `set-key` → `import-key` (legacy proxy accounts).

### Error codes

The new codes are below. The ones from #145 carry over: `unsupported_market_version` (only if V2 markets fail in the milestone), `market_not_accepting_orders` and `offset_removed`.

- **Account:** `not_set_up`
- **Funding:** `below_bridge_minimum`, `insufficient_pusd`, `insufficient_shares`, `bridge_pending`
- **Region:** `region_blocked`, `region_close_only`
- **Orders:** `price_guard` (the estimated fill is worse than `--max-price` or `--min-price`), `outcome_not_found`, `ambiguous_market`

### Skills

- Rewrite `skills/polygon-polymarket/SKILL.md` around the flow above: a status-first "start here" table, the money flow, region rules, and the codes.
- In `skills/polygon-oms-wallet/SKILL.md`, drop Polymarket from the `owner_required` list and add a short Polymarket section.
- Keep `skills/polygon-agent-cli/SKILL.md` (the command reference) in sync.

## Out of scope

- Price watches on outcomes (follow-up on #143's watch engine)
- Perps and combos
- Polymarket session keys
- Migrating legacy proxy positions
- Auto-redeem opt-in (Polymarket marks it experimental)

## Testing

- **Unit:** the adapter against a mocked SDK and mocked bridge (error mapping, outcome resolution, price guard, region rules, `--max-price` math). Command tests through yargs, always with `--dry-run`.
- **Session mode:** `deposit` goes through the allowance ledger, and `withdraw` can only target the OMS wallet.
- **Live milestone** (needs your OK, about $3 at risk): `setup` → `deposit 3` → `buy` $1 on a liquid market → `sell all` → `withdraw all`. Run once in owner mode and once in session mode. It also confirms whether Polymarket's terms of service must be accepted for API-created accounts, and whether V2 markets trade.

## Open items

1. **Builder code:** register Polygon's builder profile and choose the default code. This is a business decision.
2. **Allowlisting:** ask Polymarket to allowlist third-party ERC-1271 wallets, which would let the OMS wallet trade directly later. It's a partnership ask, and nothing here depends on it.
