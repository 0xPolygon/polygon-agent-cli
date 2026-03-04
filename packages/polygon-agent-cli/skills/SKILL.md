---
name: polygon-agent-cli
description: Complete Polygon agent CLI. Session-based smart contract wallets (Sequence), token ops (send/swap/bridge/deposit via Trails), ERC-8004 on-chain identity + reputation, x402 micropayments. Single CLI entry point, AES-256-GCM encrypted storage.
---

# Polygon Agent CLI

## Prerequisites

- Node.js 20+
- Run via npx: `npx @polygonlabs/agent-cli <command>`
- Storage: `~/.polygon-agent/` (AES-256-GCM encrypted)

## Session Initialization

**Before running any commands**, use the Read tool to check `~/.polygon-agent/builder.json`:

- **If it exists** — extract `accessKey` from the JSON and export as plain shell vars (no `$()` subshells):
  ```bash
  export SEQUENCE_PROJECT_ACCESS_KEY=<accessKey>
  export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
  export TRAILS_API_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
  ```
- **If it doesn't exist** — the user hasn't completed setup yet. Proceed to Phase 1 (`setup`) which will create the file.

## Architecture

| Wallet           | Created by      | Purpose                    | Fund? |
| ---------------- | --------------- | -------------------------- | ----- |
| EOA              | `setup`         | Auth with Sequence Builder | NO    |
| Ecosystem Wallet | `wallet create` | Primary spending wallet    | YES   |

## Environment Variables

### Required

| Variable                      | When                                           |
| ----------------------------- | ---------------------------------------------- |
| `SEQUENCE_PROJECT_ACCESS_KEY` | Wallet creation, swaps, balance checks, Trails |

**One key, three names** — `SEQUENCE_INDEXER_ACCESS_KEY` and `TRAILS_API_KEY` are the same value as `SEQUENCE_PROJECT_ACCESS_KEY`. Set them all once:

```bash
export SEQUENCE_PROJECT_ACCESS_KEY=<access-key-from-setup>
export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
export TRAILS_API_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
```

### Optional

| Variable                           | Default                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `SEQUENCE_ECOSYSTEM_CONNECTOR_URL` | `https://agentconnect.polygon.technology/`            |
| `SEQUENCE_DAPP_ORIGIN`             | Same as connector URL origin                          |
| `TRAILS_TOKEN_MAP_JSON`            | Token-directory lookup                                |
| `POLYGON_AGENT_DEBUG_FETCH`        | Off — logs HTTP to `~/.polygon-agent/fetch-debug.log` |
| `POLYGON_AGENT_DEBUG_FEE`          | Off — dumps fee options to stderr                     |

## Complete Setup Flow

```bash
# Phase 1: Setup (creates EOA + Sequence project, returns access key)
polygon-agent setup --name "MyAgent"
# → save privateKey (not shown again), eoaAddress, accessKey

# Phase 2: Create ecosystem wallet (auto-waits for browser approval)
export SEQUENCE_PROJECT_ACCESS_KEY=<accessKey>
polygon-agent wallet create --usdc-limit 100 --native-limit 5

# Phase 3: Fund wallet
polygon-agent fund
# → reads walletAddress from session, builds Trails widget URL with toAddress=<walletAddress>
# → ALWAYS run this command to get the URL — never construct it manually or hardcode any address
# → send the returned `fundingUrl` to the user; `walletAddress` in the output confirms the recipient

# Phase 4: Verify (SEQUENCE_INDEXER_ACCESS_KEY is the same as your project access key)
export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
polygon-agent balances

# Phase 5: Register agent on-chain (ERC-8004, Polygon mainnet)
polygon-agent agent register --name "MyAgent" --broadcast
# → mints ERC-721 NFT, emits agentId in Registered event
# → use agentId for reputation queries and feedback
```

## Commands Reference

### Setup

```bash
polygon-agent setup --name <name> [--force]
```

### Wallet

```bash
polygon-agent wallet create [--name <n>] [--chain polygon] [--timeout <sec>] [--no-wait]
  [--native-limit <amt>] [--usdc-limit <amt>] [--usdt-limit <amt>]
  [--token-limit <SYM:amt>]  # repeatable
  [--usdc-to <addr> --usdc-amount <amt>]  # one-off scoped transfer
  [--contract <addr>]  # whitelist contract (repeatable)
polygon-agent wallet import --ciphertext '<blob>|@<file>' [--name <n>] [--rid <rid>]
polygon-agent wallet list
polygon-agent wallet address [--name <n>]
polygon-agent wallet remove [--name <n>]
```

### Operations

```bash
polygon-agent balances [--wallet <n>] [--chain <chain>]
polygon-agent send --to <addr> --amount <num> [--symbol <SYM>] [--broadcast]
polygon-agent send-native --to <addr> --amount <num> [--broadcast] [--direct]
polygon-agent send-token --symbol <SYM> --to <addr> --amount <num> [--broadcast]
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
polygon-agent agent reputation --agent-id <id> [--tag1 <tag>]
polygon-agent agent reviews --agent-id <id>
polygon-agent agent feedback --agent-id <id> --value <score> [--tag1 <t>] [--tag2 <t>] [--endpoint <e>] [--broadcast]
```

**ERC-8004 contracts (Polygon mainnet):**

- IdentityRegistry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- ReputationRegistry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Key Behaviors

- **Dry-run by default** — all write commands require `--broadcast` to execute
- **Smart defaults** — `--wallet main`, `--chain polygon`, auto-wait on `wallet create`
- **Fee preference** — auto-selects USDC over native POL when both available
- **`fund`** — reads `walletAddress` from the wallet session and sets it as `toAddress` in the Trails widget URL. Always run `polygon-agent fund` to get the correct URL — never construct it manually or hardcode any address. The returned JSON contains `fundingUrl` and `walletAddress` so you can confirm the pre-filled recipient before sharing.
- **`deposit`** — picks highest-TVL pool via Trails `getEarnPools`. **Important**: `--usdc-limit` restricts the USDC session to `transfer` calls only, which blocks the `approve` call that deposit requires. To use `deposit`, omit `--usdc-limit` and instead whitelist USDC via `--contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (unrestricted). Also add the protocol pool address via `--contract <depositAddress>`.
- **`x402-pay`** — probes endpoint for 402, smart wallet funds builder EOA with exact token amount, EOA signs EIP-3009 payment. Chain auto-detected from 402 response
- **`send-native --direct`** — bypasses ValueForwarder contract for direct EOA transfer
- **Session permissions** — without `--usdc-limit` etc., session gets bare-bones defaults and may not transact

## CRITICAL: Wallet Approval URL

When `wallet create` outputs a URL in the `url` or `approvalUrl` field, you **MUST** send the COMPLETE, UNTRUNCATED URL to the user. The URL contains cryptographic parameters (public key, callback token) that are required for session approval. If any part is cut off, the approval will fail.

- Do NOT shorten, summarize, or add `...` to the URL
- Do NOT split the URL across multiple messages
- Output the raw URL exactly as returned by the CLI

## Callback Modes

The `wallet create` command automatically starts a local HTTP server and opens a **Cloudflare Quick Tunnel** (`*.trycloudflare.com`) — no account or token required. The `cloudflared` binary is auto-downloaded to `~/.polygon-agent/bin/cloudflared` on first use if not already installed. The connector UI POSTs the encrypted session back through the tunnel regardless of where the agent is running. The tunnel and server are torn down automatically once the session is received.

**Timing**: The `approvalUrl` is only valid while the CLI process is running. Open it immediately and complete wallet approval within the timeout window (default 300s). Never reuse a URL from a previous run — the tunnel is torn down when the CLI exits.

**Manual fallback** (if cloudflared is unavailable): The CLI omits `callbackUrl` so the connector UI displays the encrypted blob in the browser. The CLI then prompts:

```text
After approving in the browser, the encrypted blob will be shown.
Paste it below and press Enter:
> <paste blob here>
```

The blob is also saved to `/tmp/polygon-session-<rid>.txt` for reference. To import later:

```bash
polygon-agent wallet import --ciphertext @/tmp/polygon-session-<rid>.txt
```

## Troubleshooting

| Issue                                 | Fix                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Builder configured already`          | Add `--force`                                                                                                                   |
| `Missing SEQUENCE_PROJECT_ACCESS_KEY` | Run `setup` first                                                                                                               |
| `Missing wallet`                      | `wallet list`, re-run `wallet create`                                                                                           |
| `Session expired`                     | Re-run `wallet create` (24h expiry)                                                                                             |
| `Fee option errors`                   | Set `POLYGON_AGENT_DEBUG_FEE=1`, ensure wallet has funds                                                                        |
| `Timed out waiting for callback`      | Add `--timeout 600`                                                                                                             |
| `callbackMode: manual` (no tunnel)    | cloudflared unavailable — paste blob from browser when prompted; blob saved to `/tmp/polygon-session-<rid>.txt`                 |
| `404` on `*.trycloudflare.com`        | CLI timed out and tunnel is gone — re-run `wallet create`, open the new `approvalUrl` immediately                               |
| `"Auto-send failed"` in browser       | Copy the ciphertext shown below that message; run `wallet import --ciphertext '<blob>'`                                         |
| Deposit session rejected              | `--usdc-limit` blocks `approve` calls — omit it and use `--contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 --contract <depositAddress>` instead |
| Wrong recipient in Trails widget      | Run `polygon-agent fund` (do not construct the URL manually); `walletAddress` in the output confirms the pre-filled `toAddress` |

## File Structure

```text
~/.polygon-agent/
├── .encryption-key       # AES-256-GCM key (auto-generated, 0600)
├── builder.json          # EOA privateKey (encrypted), eoaAddress, accessKey, projectId
├── wallets/<name>.json   # walletAddress, session, chainId, chain
└── requests/<rid>.json   # Pending wallet creation requests
```
