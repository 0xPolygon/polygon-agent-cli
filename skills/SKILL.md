---
name: Polygon Agent
description: "Complete Polygon agent toolkit for on-chain operations on Polygon. Use this skill whenever helping an agent set up a wallet, check balances, send or swap tokens, bridge assets, deposit or withdraw from yield (Aave aTokens, ERC-4626 vaults), register on-chain identity, submit or query reputation/feedback, or make x402 micropayments. Covers the full lifecycle: OMS smart contract wallets, Trails DeFi actions, ERC-8004 identity + reputation, x402 payments. Single CLI entry point (`polygon-agent`), AES-256-GCM encrypted storage."
---

# Polygon Agentic CLI

## Prerequisites
- Node.js 20+
- Install globally: `npm install -g @polygonlabs/agent-cli` (reinstall to update)
- Entry point: `polygon-agent <command>`
- Storage: `~/.polygon-agent/` (AES-256-GCM encrypted)

> **Note for the agent: on first install, tell the user this is a global npm install** — installs the `polygon-agent` CLI system-wide so it runs from any terminal, may need sudo on some setups, re-running the same command updates it, and `npm uninstall -g @polygonlabs/agent-cli` removes it. Mention once on first install.

## If a command fails with "Unknown argument" or "command not found"

This skill is versioned with the CLI — commands and flags drift across releases. Check your version, compare to latest, and upgrade if behind:

```bash
polygon-agent --version                        # currently installed
npm view @polygonlabs/agent-cli version        # latest published
npm install -g @polygonlabs/agent-cli@latest   # upgrade
```

## Architecture

The CLI uses the **OMS (Open Money Stack) V3 embedded-wallet** model (`@0xsequence/typescript-sdk`). The agent authenticates with **Google browser login** via `wallet login`; the command prints/opens a Google sign-in URL, and once the user signs in the wallet is created/unlocked and the session credential is stored encrypted on disk. There is no on-chain permission scoping.

| Wallet | Created by | Purpose | Fund? |
|--------|-----------|---------|-------|
| Embedded wallet (V3) | `wallet login` | Primary spending wallet | YES |

The wallet address is the **same across all EVM chains**. Sessions last ~1 week before re-login is needed.

## Environment Variables

### OMS credentials (required)

`wallet login` and on-chain reads need one value from the [OMS Builder](https://sequence.build) dashboard:

| Variable | Description |
|----------|-------------|
| `SEQUENCE_PUBLISHABLE_KEY` | OMS publishable key (safe in client) — identifies the project on its own |

Set it via env, or persist once with `setup` so every command reads it from `~/.polygon-agent/builder.json`:
```bash
polygon-agent setup --oms-publishable-key <key>
```

`--oms-project-id <proj_...>` is also accepted but optional — it's kept only as legacy display metadata.

### Optional overrides
| Variable | Default |
|----------|---------|
| `SEQUENCE_PROJECT_ACCESS_KEY` | Used only as the Trails API key for DeFi earn-pool lookups (optional) |
| `TRAILS_TOKEN_MAP_JSON` | Token-directory lookup |
| `POLYGON_AGENT_DEBUG_FETCH` | Off — logs HTTP to `~/.polygon-agent/fetch-debug.log` |
| `POLYGON_AGENT_DEBUG_FEE` | Off — dumps fee options to stderr |

## Complete Setup Flow

```bash
# Step 1: Save OMS credentials (from the OMS Builder dashboard)
polygon-agent setup --oms-publishable-key <key>
# → stores publishableKey to ~/.polygon-agent/builder.json
# → all subsequent commands auto-load it from disk — no export needed

# Step 2: Log in with Google in the browser
polygon-agent wallet login
# → prints/opens a Google sign-in URL
# → after the user signs in, the embedded wallet is created/unlocked
# → on a headless/remote host add --remote (uses a public OIDC relay)
# → session saved to ~/.polygon-agent/oms/main/; prints the walletAddress

# Step 3: Fund wallet
polygon-agent fund
# → reads walletAddress from the session, builds the Trails widget URL with toAddress=<walletAddress>
# → ALWAYS run this command to get the URL — never construct it manually or hardcode any address
# → send the returned `fundingUrl` to the user; `walletAddress` in the output confirms the recipient

# Step 4: Verify balances
polygon-agent balances

# Step 5: Register agent on-chain (ERC-8004, Polygon mainnet only)
polygon-agent agent register --name "MyAgent" --broadcast
# → mints ERC-721 NFT, emits Registered event containing agentId
# → retrieve agentId: open the tx on https://polygonscan.com, go to Logs tab,
#   find the Registered event — agentId is the first indexed parameter
# → use agentId for reputation queries, reviews, and feedback
```

## Use-Case Skills

For specific workflows, fetch and load the relevant sub-skill **before attempting the task**:

| Use Case | Skill URL |
|----------|-----------|
| Polymarket prediction market trading | https://agentconnect.polygon.technology/polygon-polymarket/SKILL.md |
| DeFi — swap, deposit, withdraw, yield | https://agentconnect.polygon.technology/polygon-defi/SKILL.md |
| x402 discovery & pay-per-call APIs | https://agentconnect.polygon.technology/polygon-discovery/SKILL.md |

> **IMPORTANT — x402 calls:** If the user asks to use x402 to fetch data (Twitter/X profiles, web search, news, AI images, code review, etc.), follow these steps in order before making any request:
>
> 1. Fetch and read the discovery skill: `GET https://agentconnect.polygon.technology/polygon-discovery/SKILL.md`
> 2. Run `polygon-agent wallet list` — if no wallet exists, log in: `polygon-agent setup --oms-publishable-key <key>` (if not already done), then `polygon-agent wallet login` and sign in with Google in the browser, then fund the wallet before continuing.
> 3. Run `polygon-agent balances` — confirm USDC is available before proceeding; x402 calls will fail with an EOA funding error if the wallet is empty
>
> Do not guess endpoints or search the web for x402 providers. The discovery skill documents the correct, working endpoints with exact URL formats.

---

## Commands Reference

### Setup
```bash
polygon-agent setup [--name <name>] [--force]
  [--oms-publishable-key <key>] [--oms-project-id <proj_...>]  # save OMS credentials (project id optional/legacy)
```

### Wallet
Valid `--chain` values for operations: `polygon` (default/mainnet), `amoy` (Polygon testnet), `mainnet` (Ethereum), `arbitrum`, `optimism`, `base`. ERC-8004 agent operations only support `polygon`. The embedded wallet address is the same on every chain.

```bash
polygon-agent wallet login [--name <n>] [--remote] [--no-fund] [--force]
# Logs in with Google in the browser: prints/opens a Google sign-in URL; after sign-in the wallet is created/unlocked.
# Add --remote on headless/remote hosts (uses a public OIDC relay; needs POLYGON_AGENT_OIDC_RELAY or --relay-url).
polygon-agent wallet logout [--name <n>]   # clears the local session
polygon-agent wallet list
polygon-agent wallet address [--name <n>]
polygon-agent wallet remove [--name <n>]
```

### Operations
```bash
polygon-agent balances [--wallet <n>] [--chain <chain>] [--chains <csv>]
polygon-agent send --to <addr> --amount <num> [--symbol <SYM>] [--token <addr>] [--decimals <n>] [--broadcast]
polygon-agent send-native --to <addr> --amount <num> [--broadcast] [--direct]
polygon-agent send-token --symbol <SYM> --to <addr> --amount <num> [--token <addr>] [--decimals <n>] [--broadcast]
polygon-agent swap --from <SYM> --to <SYM> --amount <num> [--to-chain <chain>] [--slippage <num>] [--broadcast]
polygon-agent deposit --asset <SYM> --amount <num> [--protocol aave|morpho] [--broadcast]
polygon-agent withdraw --position <addr> --amount <num|max> [--chain <chain>] [--broadcast]
polygon-agent fund [--wallet <n>] [--token <addr>]
polygon-agent x402-pay --url <url> --wallet <n> [--method GET] [--body <str>] [--header Key:Value]
```

### Agent (ERC-8004)
```bash
polygon-agent agent register --name <n> [--agent-uri <uri>] [--metadata <k=v,k=v>] [--broadcast]
polygon-agent agent wallet --agent-id <id>
polygon-agent agent metadata --agent-id <id> --key <key>
polygon-agent agent reputation --agent-id <id> [--tag1 <tag>] [--tag2 <tag>]
polygon-agent agent reviews --agent-id <id> [--tag1 <t>] [--tag2 <t>] [--revoked]
polygon-agent agent feedback --agent-id <id> --value <score> [--tag1 <t>] [--tag2 <t>] [--endpoint <e>] [--feedback-uri <uri>] [--broadcast]
```

**ERC-8004 contracts (Polygon mainnet):**
- IdentityRegistry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- ReputationRegistry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Key Behaviors

- **Dry-run by default** — all write commands require `--broadcast` to execute
- **Smart defaults** — `--wallet main`, `--chain polygon`
- **`balances --chains`** — comma-separated chains (max 20); two or more return JSON with `multiChain: true` and a `chains` array (same wallet address on each)
- **Fee preference** — auto-selects USDC over native POL when both available; the relayer pays gas in whichever fee token the wallet can afford
- **`fund`** — returns `https://wallet.polygon.technology` as the `fundingUrl`. Always run `polygon-agent fund` to get the URL and wallet address — never hardcode or construct manually.
- **`deposit`** — picks highest-TVL pool via Trails `getEarnPools` and deposits directly. Full deposit reference: https://agentconnect.polygon.technology/polygon-defi/SKILL.md
- **Gas reserve** — when using `deposit` or any command that spends tokens, always reserve at least 0.1 USDC or 0.1 POL in the wallet for gas. Never attempt to spend the full balance. The `deposit` command enforces a 0.1 reserve automatically, but the agent must apply the same rule when constructing amounts for `send`, `swap`, or `call`.
- **`withdraw`** — `--position` = aToken or ERC-4626 vault; `--amount` = `max` or underlying units (Aave / vault). Dry-run JSON includes `poolAddress` / `vault`.
- **`x402-pay`** — probes endpoint for 402, the wallet funds a builder EOA with the exact token amount, the EOA signs the EIP-3009 payment. Chain auto-detected from the 402 response
- **`call`** — submit arbitrary pre-encoded calldata: `polygon-agent call --to <addr> --data 0x... [--value <amt>] [--prefer-native-fee] [--broadcast]`. The wallet can call any contract (no permission scoping in the V3 model)
- **`send-native --direct`** — bypasses ValueForwarder contract for direct EOA transfer
- **No permission scoping** — the V3 embedded wallet can call any contract and spend any amount it holds; there are no per-contract whitelists or spend limits. Guard spending in agent logic, not at the wallet layer.
- **Session expiry** — ~1 week from login; on expiry, re-run `wallet login`

## Presenting Results to the User

CLI commands output JSON (non-TTY). After running a command, always render the result as formatted markdown — never paste raw JSON into the conversation.

| Command | How to present |
|---------|---------------|
| `balances` | Markdown table: Token / Balance columns. Show wallet address and chain above the table. |
| `send` / `send-token` / `send-native` | One-liner summary: amount, symbol, recipient. If broadcast, show tx hash as a code span and explorer URL as a link. |
| `swap` | Summary: `X FROM → Y TO` with chain. If broadcast, show deposit tx hash + explorer link. |
| `deposit` | Summary: amount, asset, protocol, pool address. If broadcast, show tx hash + explorer link. |
| `withdraw` | Summary: `kind` (aave / erc4626), position, amount, pool or vault. If broadcast, show tx hash + explorer link. |
| `fund` | Show the `fundingUrl` as a clickable link with a brief instruction to open it. |
| `wallet login` / `wallet list` | Wallet name, truncated address, chain in a small table or bullet list. |
| `agent register` | Show agent name and tx hash as a code span with Polygonscan link. Remind user to retrieve `agentId` from the Registered event on the Logs tab. |
| `agent wallet` | Show `agentId`, wallet address, and whether a wallet is set. |
| `agent metadata` | Show `agentId`, key, and decoded value. |
| `agent reputation` | Format score and tag breakdown as a small table. |

**Dry-run results** — always make it visually clear this was a simulation. Prefix with `⚡ Dry run` and show what *would* happen. Remind the user to re-run with `--broadcast` to execute.

**Errors** — extract the `error` field and present it as a clear sentence, not a JSON blob. Include the relevant fix from the Troubleshooting table if applicable.

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `OMS credentials not configured` | Run `setup --oms-publishable-key <key>` (or set `SEQUENCE_PUBLISHABLE_KEY`) |
| `Wallet not found` | `wallet list`, then `polygon-agent wallet login` |
| Session expired (`OMS_SESSION_EXPIRED`) | Run `polygon-agent wallet login` (~1-week lifetime) |
| `Fee option errors` | Set `POLYGON_AGENT_DEBUG_FEE=1`, ensure wallet has POL or a fee token. For native-only wallets, add `--prefer-native-fee` on `call` |
| Wrong recipient in Trails widget | Run `polygon-agent fund` (do not construct the URL manually) |
| `x402-pay`: no 402 response | Endpoint doesn't require x402 payment, or URL is wrong |
| `x402-pay`: payment token mismatch | Chain/token in the 402 response differs from wallet — check `--wallet` points to the right chain |
| `x402-pay`: EOA funding failed | Wallet lacks sufficient balance to cover the payment amount — run `balances` and fund if needed |

## File Structure
```
~/.polygon-agent/
├── .encryption-key          # AES-256-GCM key (auto-generated, 0600)
├── builder.json             # publishableKey, omsProjectId, polymarket/EOA keys (encrypted)
├── wallets/<name>.json      # OMS wallet pointer: walletAddress, loginMethod
└── oms/<name>/              # OMS SDK session storage + encrypted credential key
```
