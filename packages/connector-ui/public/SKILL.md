---
name: Polygon Agent
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
# → notify the user and send them to https://agentconnect.polygon.technology/?rid=<rid>
#   so they can fund their wallet with access to the session

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

## x402 Bazaar Services

Pay-per-call APIs accessible via `x402-pay`. No API keys or subscriptions — each call costs a small USDC amount drawn from your wallet. The CLI detects the 402 response, funds the exact amount, and retries automatically.

**Catalog:** `GET https://x402-api.onrender.com/api/catalog?status=online`

### Read Twitter/X profiles & tweets
$0.005 USDC per call.
```bash
# Profile + recent tweets
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/twitter?user=<username>" \
  --wallet main --method POST

# Specific tweet
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/twitter?tweet=https://x.com/user/status/<id>" \
  --wallet main --method POST
```
Returns: follower count, recent tweets, engagement metrics.

### Generate an AI image
$0.02 USDC per call. Powered by Google Gemini.
```bash
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/call/2998d205-94d9-4f7e-8f8a-201a090a5530?prompt=<description>&size=512" \
  --wallet main --method POST
```
`size` options: `256`, `512`, `1024`. Returns JSON with `data_uri` (base64 PNG) for embedding.

### Score a sales lead
$0.01 USDC per call.
```bash
polygon-agent x402-pay \
  --url "https://x402-api.onrender.com/api/call/31bf0100-2674-4706-a3d4-fc631d44c649?domain=<domain>" \
  --wallet main --method POST
```
Returns: 0–100 score, A–F grade, and 7 signal breakdown: domain age, email setup (MX records), SSL health, DNS configuration, GitHub presence, and tech stack.

### Other useful services

| Service | Price | Endpoint | Key param |
|---------|-------|----------|-----------|
| Web search (DuckDuckGo) | $0.005 | `9b0f5b5f-8e6c-4b55-a264-008e4e490c26` | `?q=<query>&max=10` |
| Latest news (Google News) | $0.005 | `266d045f-bae2-4c71-9469-3638ec860fc4` | `?topic=<topic>&lang=en` |
| Summarize text (GPT-4o-mini) | $0.01 | `dd9b5098-700d-47a9-a41a-c9eae66ca49d` | `?text=<text>&maxLength=200` |
| Article → Markdown | $0.005 | `87b50238-5b99-4521-b5e1-7515a9c1526d` | `?url=<article-url>` |
| Sentiment analysis (GPT-4o-mini) | $0.005 | `66d68ca6-a8d9-41a3-b024-a3fac2f5c7ba` | `?text=<text>` |

All use POST via `polygon-agent x402-pay --url "https://x402-api.onrender.com/api/call/<id><params>" --wallet main --method POST`.

## Yield Vault Contract Whitelist

To deposit into yield vaults, the wallet session must pre-whitelist each vault contract. When creating a wallet for yield/deposit use cases, add `--contract` flags for the vaults you intend to use. Also omit `--usdc-limit` and pass `--contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (USDC) instead — `--usdc-limit` blocks the `approve` calls that deposit requires.

**Example wallet create for yield:**
```bash
polygon-agent wallet create \
  --contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 \
  --contract <vault-address> \
  --native-limit 5
```

### Katana (chainId 747474) — Morpho vaults

| Vault | Protocol | Asset | TVL | Address |
|-------|----------|-------|-----|---------|
| Gauntlet USDT | Morpho | USDT | ~$97M | `0x1ecdc3f2b5e90bfb55ff45a7476ff98a8957388e` |
| Steakhouse Prime USDC | Morpho | USDC | ~$54M | `0x61d4f9d3797ba4da152238c53a6f93fb665c3c1d` |
| Yearn OG ETH | Morpho | WETH | ~$16M | `0xfade0c546f44e33c134c4036207b314ac643dc2e` |
| Yearn OG USDC | Morpho | USDC | ~$16M | `0xce2b8e464fc7b5e58710c24b7e5ebfb6027f29d7` |
| Gauntlet USDC | Morpho | USDC | ~$8M | `0xe4248e2105508fcbad3fe95691551d1af14015f7` |
| Yearn OG USDT | Morpho | USDT | ~$8M | `0x8ed68f91afbe5871dce31ae007a936ebe8511d47` |
| Gauntlet WETH | Morpho | WETH | ~$6M | `0xc5e7ab07030305fc925175b25b93b285d40dcdff` |
| Hyperithm vbUSDC Apex | Morpho | USDC | ~$3M | `0xef77f8c53af95f3348cee0fb2a02ee02ab9cdca5` |

### Polygon mainnet (chainId 137)

| Protocol | Asset | Address |
|----------|-------|---------|
| Aave V3 Pool (all markets) | USDC, USDT, WETH, WMATIC… | `0x794a61358d6845594f94dc1db02a252b5b4814ad` |
| Morpho Compound USDC | USDC | `0x781fb7f6d845e3be129289833b04d43aa8558c42` |
| Morpho Compound WETH | WETH | `0xf5c81d25ee174d83f1fd202ca94ae6070d073ccf` |
| Morpho Compound POL | POL | `0x3f33f9f7e2d7cfbcbdf8ea8b870a6e3d449664c2` |

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
