---
name: polygon-agent-cli-quickstart
description: Quick start guide for Polygon Agent CLI. Get project access key, create wallet with session permissions, register agent onchain, perform token operations. Context-efficient workflow for autonomous agents.
---

# Polygon Agent CLI - Quick Start

**Goal**: Zero to operational agent in 4 phases.

## Prerequisites

- Node.js 22+
- Run via npx: `npx @polygonlabs/agent-cli <command>`
- Or install globally for the shorter `polygon-agent` command: `npm install -g @polygonlabs/agent-cli`

## Session Initialization

**Before running any commands**, use the Read tool to check `~/.polygon-agent/builder.json`:

- **If it exists** — extract `accessKey` from the JSON and export as plain shell vars (no `$()` subshells):
  ```bash
  export SEQUENCE_PROJECT_ACCESS_KEY=<accessKey>
  export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
  export TRAILS_API_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
  ```
- **If it doesn't exist** — the user hasn't completed setup yet. Proceed to Phase 1 (`setup`) which will create the file.

## Phase 1: Setup

```bash
polygon-agent setup --name "MyAgent"
```

Outputs `accessKey` — needed for all wallet operations. Save `privateKey` for backup.

---

## Phase 2: Create Wallet

```bash
export SEQUENCE_PROJECT_ACCESS_KEY=<access-key-from-phase-1>
```

`SEQUENCE_ECOSYSTEM_CONNECTOR_URL` defaults to `https://agentconnect.polygon.technology/` (the hosted connector). Override via env var to point at a local dev server or a different deployment.

### Option A: Auto-Wait (Default — zero copy/paste)

```bash
polygon-agent wallet create
```

The CLI automatically opens a **Cloudflare Quick Tunnel** (`*.trycloudflare.com`) and passes the callback URL to the connector UI. Open the URL in a browser → approve → the CLI receives the session automatically. Works whether the agent is local or remote. No account or token required — `cloudflared` is auto-downloaded to `~/.polygon-agent/bin/` on first use.

**CRITICAL**: The CLI outputs an `approvalUrl` that the user must open in a browser. You MUST send the COMPLETE, UNTRUNCATED URL to the user. Do NOT shorten it or add `...` — the URL contains cryptographic parameters that will break if truncated.

**IMPORTANT — open the URL immediately**: The approval link is only valid while the CLI process is running. The tunnel and 5-minute timeout start together. Do NOT reuse a URL from a previous run — if the CLI has already exited, the tunnel is gone and you will get a 404 from the cloudflared URL. Simply re-run `wallet create` to get a fresh URL.

**If cloudflared is unavailable** (`callbackMode: manual`): The browser will display the encrypted blob instead of posting it back. The CLI will prompt you to paste it:

```text
After approving in the browser, the encrypted blob will be shown.
Paste it below and press Enter:
> <paste blob here>
```

The blob is also saved to `/tmp/polygon-session-<rid>.txt` automatically.

### Option B: Manual (explicit no-wait)

```bash
polygon-agent wallet create --no-wait
# Open output URL, approve, copy blob:
polygon-agent wallet import --ciphertext @/tmp/session.txt
```

### Session Permissions

Control what the session can do. Without these, the agent gets bare-bones defaults and may not be able to transact.

```bash
polygon-agent wallet create \
  --native-limit 5 \
  --usdc-limit 100 \
  --usdt-limit 50 \
  --token-limit WETH:0.5 \
  --contract 0xABAAd93EeE2a569cF0632f39B10A9f5D734777ca
```

| Flag                      | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `--native-limit <amt>`    | Max POL the session can spend                              |
| `--usdc-limit <amt>`      | Max USDC the session can transfer                          |
| `--usdt-limit <amt>`      | Max USDT the session can transfer                          |
| `--token-limit <SYM:amt>` | Max for any token by symbol (repeatable)                   |
| `--usdc-to <addr>`        | Restrict USDC to this recipient (requires `--usdc-amount`) |
| `--usdc-amount <amt>`     | USDC amount for `--usdc-to` recipient                      |
| `--contract <addr>`       | Whitelist contract address (repeatable)                    |

> **Deposit / DeFi note**: `--usdc-limit` restricts the session to USDC `transfer` calls only — this blocks the `approve` call that `deposit` (Aave/Morpho) requires. If you plan to use `deposit`, **omit `--usdc-limit`** and whitelist USDC and the protocol pool via `--contract` instead:
>
> ```bash
> polygon-agent wallet create \
>   --native-limit 5 \
>   --contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 \
>   --contract 0x794a61358d6845594f94dc1db02a252b5b4814ad
> # ^ USDC (unrestricted, allows approve)   ^ Aave V3 pool (Polygon mainnet)
> ```

**After approval**: Fund `walletAddress` with POL + tokens.

### Fund wallet via Trails

```bash
polygon-agent fund
```

Opens a Trails widget URL pre-filled with your wallet address. Open the URL in a browser to swap/bridge tokens into your wallet.

---

## Phase 3: Register Agent (ERC-8004)

```bash
polygon-agent agent register --name "MyAgent" --broadcast
```

Mints ERC-721 NFT with `agentId`. Check transaction for Registered event.

---

## Phase 4: Token Operations

```bash
# Balances (SEQUENCE_INDEXER_ACCESS_KEY is the same key from Phase 1)
export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
polygon-agent balances

# Send POL (via ValueForwarder)
polygon-agent send --to 0x... --amount 1.0 --broadcast

# Send POL direct (bypass ValueForwarder)
polygon-agent send-native --to 0x... --amount 1.0 --broadcast --direct

# Send ERC20
polygon-agent send --symbol USDC --to 0x... --amount 10 --broadcast

# DEX Swap
polygon-agent swap --from USDC --to USDT --amount 5 --slippage 0.005 --broadcast
```

Omit `--broadcast` for dry-run preview.

---

## Commands Summary

| Command                   | Purpose                                 |
| ------------------------- | --------------------------------------- |
| `setup`                   | Get project access key                  |
| `wallet create`           | Create wallet (auto-waits for approval) |
| `wallet create --no-wait` | Generate session link (manual flow)     |
| `wallet import`           | Import encrypted session                |
| `wallet list`             | List configured wallets                 |
| `agent register`          | Register agent onchain (ERC-8004)       |
| `fund`                    | Open Trails widget to fund wallet       |
| `balances`                | Check token balances                    |
| `send [--symbol SYM]`     | Send native or ERC20                    |
| `send-native [--direct]`  | Send POL/MATIC (explicit)               |
| `send-token`              | Send ERC20 by symbol (explicit)         |
| `swap`                    | DEX swap via Trails                     |
| `agent wallet`            | Get agent's payment wallet              |
| `agent reputation`        | Get agent reputation score              |
| `agent feedback`          | Submit on-chain feedback                |
| `agent reviews`           | Read all agent feedback                 |

**Smart defaults**: `--wallet main`, `--chain polygon`, `--name main`. Most commands need zero flags.

---

## Environment Variables

**One key covers everything**:

```bash
export SEQUENCE_PROJECT_ACCESS_KEY=<access-key-from-setup>
```

`SEQUENCE_INDEXER_ACCESS_KEY` and `TRAILS_API_KEY` are the same value — set them all to your project access key:

```bash
export SEQUENCE_INDEXER_ACCESS_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
export TRAILS_API_KEY=$SEQUENCE_PROJECT_ACCESS_KEY
```

**Defaults** (override if needed):
`SEQUENCE_ECOSYSTEM_CONNECTOR_URL` → `https://agentconnect.polygon.technology/`

**Optional**: `TRAILS_TOKEN_MAP_JSON`, `POLYGON_AGENT_DEBUG_FETCH=1`, `POLYGON_AGENT_DEBUG_FEE=1`

---

## Error Recovery

| Issue                            | Fix                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Session expired                  | Re-run `wallet create`                                                                                      |
| Insufficient funds               | Fund wallet address with POL                                                                                |
| Fee errors                       | Set `POLYGON_AGENT_DEBUG_FEE=1` to inspect                                                                  |
| Tx failed                        | Omit `--broadcast` for dry-run first                                                                        |
| Callback timeout                 | `--timeout 600`                                                                                             |
| `callbackMode: manual` shown     | cloudflared unavailable — paste blob from browser when prompted                                             |
| 404 on `*.trycloudflare.com` URL | CLI timed out before you approved — re-run `wallet create` and open the new URL immediately                 |
| "Auto-send failed" in browser    | Ciphertext is shown below the message — copy it and run `polygon-agent wallet import --ciphertext '<blob>'` |
| Deposit fails (`approve` blocked) | `--usdc-limit` allows `transfer` only — omit it and use `--contract 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 --contract <poolAddress>` |

---

## Storage

All credentials: `~/.polygon-agent/` (AES-256-GCM encrypted)

Repository: <https://github.com/0xPolygon/polygon-agent-cli>
