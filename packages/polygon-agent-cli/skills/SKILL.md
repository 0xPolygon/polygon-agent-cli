---
name: polygon-agent-cli
description: "Complete Polygon agent toolkit for on-chain operations on Polygon. Use this skill whenever helping an agent set up a wallet, check balances, send or swap tokens, bridge assets, deposit to earn yield, register on-chain identity, submit or query reputation/feedback, or make x402 micropayments. Covers the full lifecycle: Sequence smart contract wallets, Trails DeFi actions, ERC-8004 identity + reputation, x402 payments. Single CLI entry point (`polygon-agent`), AES-256-GCM encrypted storage."
---

# Polygon Agentic CLI

## Prerequisites
- Node.js 20+
- Install globally: `npm install -g github:0xPolygon/polygon-agent-kit` (reinstall to update)
- Entry point: `polygon-agent <command>`
- Storage: `~/.polygon-agent/` (AES-256-GCM encrypted)

## Architecture

| Wallet | Created by | Purpose | Fund? |
|--------|-----------|---------|-------|
| EOA | `setup` | Auth with Sequence Builder | NO |
| Ecosystem Wallet | `wallet create` | Primary spending wallet | YES |

## Environment Variables

### Access key — auto-loaded, no export needed

After `setup` runs, the access key is stored in `~/.polygon-agent/builder.json`. The CLI bootstraps it into `SEQUENCE_PROJECT_ACCESS_KEY` and `SEQUENCE_INDEXER_ACCESS_KEY` automatically on every invocation. Trails commands additionally fall back through `session.projectAccessKey` → `SEQUENCE_PROJECT_ACCESS_KEY`, so `TRAILS_API_KEY` also does not need to be exported manually.

**In a fresh agent session with no environment variables set**, simply run commands — the CLI reads credentials from disk. No `export` step is required between phases.

Only set these manually to override the stored value (e.g. to point at a different project):
```bash
export SEQUENCE_PROJECT_ACCESS_KEY=<override-key>
```

### Optional overrides
| Variable | Default |
|----------|---------|
| `SEQUENCE_ECOSYSTEM_CONNECTOR_URL` | `https://agentconnect.polygon.technology` |
| `SEQUENCE_DAPP_ORIGIN` | Same as connector URL origin |
| `TRAILS_TOKEN_MAP_JSON` | Token-directory lookup |
| `POLYGON_AGENT_DEBUG_FETCH` | Off — logs HTTP to `~/.polygon-agent/fetch-debug.log` |
| `POLYGON_AGENT_DEBUG_FEE` | Off — dumps fee options to stderr |

## Complete Setup Flow

```bash
# Step 1: Setup (creates EOA + Sequence project, stores access key to disk)
polygon-agent setup --name "MyAgent"
# → saves privateKey (not shown again), eoaAddress, accessKey to ~/.polygon-agent/builder.json
# → all subsequent commands auto-load the access key from disk — no export needed

# Step 2: Create ecosystem wallet (opens browser, waits for 6-digit code)
polygon-agent wallet create --usdc-limit 100 --native-limit 5
# → opens https://agentconnect.polygon.technology/link?rid=<rid>&...
# → user approves in browser, browser shows a 6-digit code
# → enter the 6-digit code in the terminal when prompted
# → session saved to ~/.polygon-agent/wallets/main.json

# Step 3: Fund wallet
polygon-agent fund
# → reads walletAddress from session, builds Trails widget URL with toAddress=<walletAddress>
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

## Commands Reference

### Setup
```bash
polygon-agent setup --name <name> [--force]
```

### Wallet
Valid `--chain` values: `polygon` (default/mainnet), `amoy` (Polygon testnet), `mainnet` (Ethereum), `arbitrum`, `optimism`, `base`. ERC-8004 agent operations only support `polygon`.

```bash
polygon-agent wallet create [--name <n>] [--chain polygon] [--timeout <sec>] [--print-url]
  [--native-limit <amt>] [--usdc-limit <amt>] [--usdt-limit <amt>]
  [--token-limit <SYM:amt>]  # repeatable
  [--usdc-to <addr> --usdc-amount <amt>]  # one-off scoped transfer
  [--contract <addr>]  # whitelist contract (repeatable)
polygon-agent wallet import --code <6-digit-code> --rid <rid> [--name <n>]
polygon-agent wallet import --ciphertext '<blob>|@<file>' [--name <n>]  # legacy
polygon-agent wallet list
polygon-agent wallet address [--name <n>]
polygon-agent wallet remove [--name <n>]
```

### Operations
```bash
polygon-agent balances [--wallet <n>] [--chain <chain>]
polygon-agent send --to <addr> --amount <num> [--symbol <SYM>] [--token <addr>] [--decimals <n>] [--broadcast]
polygon-agent send-native --to <addr> --amount <num> [--broadcast] [--direct]
polygon-agent send-token --symbol <SYM> --to <addr> --amount <num> [--token <addr>] [--decimals <n>] [--broadcast]
polygon-agent swap --from <SYM> --to <SYM> --amount <num> [--to-chain <chain>] [--slippage <num>] [--broadcast]
polygon-agent deposit --asset <SYM> --amount <num> [--protocol aave|morpho] [--broadcast]
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
- **Smart defaults** — `--wallet main`, `--chain polygon`, auto-wait on `wallet create`
- **Fee preference** — auto-selects USDC over native POL when both available
- **`fund`** — reads `walletAddress` from the wallet session and sets it as `toAddress` in the Trails widget URL. Always run `polygon-agent fund` to get the correct URL — never construct it manually or hardcode any address.
- **`deposit`** — picks highest-TVL pool via Trails `getEarnPools`. If session rejects (contract not whitelisted), re-create wallet with `--contract <depositAddress>`
- **`x402-pay`** — probes endpoint for 402, smart wallet funds builder EOA with exact token amount, EOA signs EIP-3009 payment. Chain auto-detected from 402 response
- **`send-native --direct`** — bypasses ValueForwarder contract for direct EOA transfer
- **Session permissions** — without `--usdc-limit` etc., session gets bare-bones defaults and may not transact
- **Session expiry** — 6 months from creation

## Wallet Creation Flow (v2 Relay)

`wallet create` uses a Cloudflare Durable Object relay and a 6-digit out-of-band code — no cloudflared tunnel required. The browser encrypts the approved session with an X25519 key negotiated via the relay; the 6-digit code is the decryption key entered in the terminal.

**`--print-url` flag:** Use this in headless or non-interactive environments (CI, remote shells) where `wallet create` can't block waiting for the code. The CLI prints the approval URL and exits immediately. Complete the flow separately:
```bash
polygon-agent wallet import --code <6-digit-code> --rid <rid>
```

## CRITICAL: Wallet Approval URL

When `wallet create` outputs a URL in the `url` or `approvalUrl` field, send the **complete, untruncated URL** to the user. The URL contains the relay request ID required for session approval.

- Do NOT shorten, summarize, or add `...` to the URL
- Do NOT split the URL across multiple messages
- Output the raw URL exactly as returned by the CLI

## Presenting Results to the User

CLI commands output JSON (non-TTY). After running a command, always render the result as formatted markdown — never paste raw JSON into the conversation.

| Command | How to present |
|---------|---------------|
| `balances` | Markdown table: Token / Balance columns. Show wallet address and chain above the table. |
| `send` / `send-token` / `send-native` | One-liner summary: amount, symbol, recipient. If broadcast, show tx hash as a code span and explorer URL as a link. |
| `swap` | Summary: `X FROM → Y TO` with chain. If broadcast, show deposit tx hash + explorer link. |
| `deposit` | Summary: amount, asset, protocol, pool address. If broadcast, show tx hash + explorer link. |
| `fund` | Show the `fundingUrl` as a clickable link with a brief instruction to open it. |
| `wallet create` / `wallet list` | Wallet name, truncated address, chain in a small table or bullet list. |
| `agent register` | Show agent name and tx hash as a code span with Polygonscan link. Remind user to retrieve `agentId` from the Registered event on the Logs tab. |
| `agent wallet` | Show `agentId`, wallet address, and whether a wallet is set. |
| `agent metadata` | Show `agentId`, key, and decoded value. |
| `agent reputation` | Format score and tag breakdown as a small table. |

**Dry-run results** — always make it visually clear this was a simulation. Prefix with `⚡ Dry run` and show what *would* happen. Remind the user to re-run with `--broadcast` to execute.

**Errors** — extract the `error` field and present it as a clear sentence, not a JSON blob. Include the relevant fix from the Troubleshooting table if applicable.

---

## Use-Case Skills

For specific workflows, load the relevant sub-skill:

| Use Case | Skill |
|----------|-------|
| Polymarket prediction market trading | [polygon-polymarket/SKILL.md](polygon-polymarket/SKILL.md) |
| DeFi — swap, deposit, yield | [polygon-defi/SKILL.md](polygon-defi/SKILL.md) |
| x402 discovery & pay-per-call APIs | [polygon-discovery/SKILL.md](polygon-discovery/SKILL.md) |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| `Builder configured already` | Add `--force` |
| `Missing SEQUENCE_PROJECT_ACCESS_KEY` | Run `setup` first |
| `Missing wallet` | `wallet list`, re-run `wallet create` |
| `Session expired` | Re-run `wallet create` (6-month expiry) |
| `Fee option errors` | Set `POLYGON_AGENT_DEBUG_FEE=1`, ensure wallet has funds |
| `Timed out waiting for wallet approval` | Add `--timeout 600` |
| `Invalid code: hash mismatch` | Wrong 6-digit code entered — retry (3 attempts allowed) |
| `Relay request not found` | Session expired or already used — re-run `wallet create` (or `wallet create --print-url`) |
| Deposit session rejected | Re-create wallet with `--contract <depositAddress>` |
| Wrong recipient in Trails widget | Run `polygon-agent fund` (do not construct the URL manually) |
| `x402-pay`: no 402 response | Endpoint doesn't require x402 payment, or URL is wrong |
| `x402-pay`: payment token mismatch | Chain/token in the 402 response differs from wallet — check `--wallet` points to the right chain |
| `x402-pay`: EOA funding failed | Wallet lacks sufficient balance to cover the payment amount — run `balances` and fund if needed |

## File Structure
```
~/.polygon-agent/
├── .encryption-key       # AES-256-GCM key (auto-generated, 0600)
├── builder.json          # EOA privateKey (encrypted), eoaAddress, accessKey, projectId
├── wallets/<name>.json   # walletAddress, session, chainId, chain
└── requests/<rid>.json   # Pending wallet creation requests (deleted after successful import)
```
