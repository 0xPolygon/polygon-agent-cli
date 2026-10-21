# Developer: global install, owner mode, configuration

**When to use:** someone is working on or with the CLI directly on their own machine, not as an assistant install: a global npm install, the full owner sign-in, transaction mode, environment variables or file layout. Assistant installs follow [install](install.md) and [connect](connect.md) instead.

## Prerequisites

- Node.js 22+
- Install globally: `npm install -g @polygonlabs/agent-cli` (re-run to update; `npm uninstall -g @polygonlabs/agent-cli` removes it). It installs the `agent` CLI system-wide and may need sudo on some setups. Tell the user this once, on first install.
- Entry point: `agent <command>`
- Storage: `~/.polygon-agent/` (AES-256-GCM encrypted)

If a command fails with "Unknown argument" or "command not found", the skill and CLI versions have drifted:

```bash
agent --version                                # currently installed
npm view @polygonlabs/agent-cli version        # latest published
npm install -g @polygonlabs/agent-cli@latest   # upgrade
```

## Owner mode

The CLI uses the **OMS (Open Money Stack) V3 embedded-wallet** model (`@polygonlabs/oms-wallet`). `wallet login --owner` is the full owner sign-in. It opens the agentconnect login page (`POLYGON_AGENT_LOGIN_UI`, default `https://agentconnect.polygon.technology`), where the user chooses Google or email (email sends a 6-digit code to the user's inbox, entered on the page). This works whether the browser is on this machine or a different one, so there is no separate headless mode. With `--owner`, `--local` falls back to the legacy loopback flow (raw Google sign-in URL plus a localhost callback; browser must be on this same machine; Google only). `--remote` (also only with `--owner`) is deprecated and is now a no-op that prints a notice. Bare `wallet login` is **session mode** now (see below). Once the user signs in, the wallet is created or unlocked and the session credential is stored encrypted on disk. There is no on-chain permission scoping.

| Wallet | Created by | Purpose | Fund? |
|--------|-----------|---------|-------|
| Embedded wallet (V3) | `wallet login` | Primary spending wallet | YES |

The wallet address is the **same across all EVM chains**. Sessions last ~1 week before re-login is needed.

Bare `wallet login` connects with an allowance instead (session mode): see [connect](connect.md) and [platforms](platforms.md) for how the sign-in method is picked.

## Owner setup flow

```bash
# Step 1: Log in as the owner in the browser (developers; assistant installs use bare
# `agent wallet login`, see Session Mode)
agent wallet login --owner
# → opens the agentconnect login page; choose Google or email (email sends
#   a 6-digit code to the user's inbox, entered on the page)
# → works whether the browser is on this machine or elsewhere, so there is
#   no separate headless mode
# → --local (with --owner) falls back to the legacy loopback flow (Google only, browser
#   must be on this machine)
# → session saved to ~/.polygon-agent/oms/main/; prints the walletAddress
# → no setup step needed: the CLI ships a default OMS publishable key, and
#   login auto-provisions a Builder project + access key to
#   ~/.polygon-agent/builder.json

# Step 1b: Choose transaction mode (asked once)
# → if the login output includes a `modePrompt` field, ask the user whether to
#   enable auto mode (writes broadcast immediately, no preview), then run:
agent mode auto      # or: agent mode dry-run
# → dry-run (default) previews every write; auto broadcasts immediately.
#   Never enable auto mode without the user's explicit answer.

# Step 2: Fund wallet
# → send the user `dashboard.url` from the login output or `agent wallet status`
#   (the fund view while the wallet is empty). Never construct the URL or hardcode an address.
agent fund
# → only when the user wants the page opened in a browser on this machine: it opens it
#   and returns the same link as `url`, with `walletAddress` confirming the recipient

# Step 3: Verify balances
agent balances

# Step 4: Register agent on-chain (ERC-8004, Polygon mainnet only)
agent register --name "MyAgent" --broadcast
# → mints ERC-721 NFT, emits Registered event containing agentId
# → retrieve agentId: open the tx on https://polygonscan.com, go to Logs tab,
#   find the Registered event — agentId is the first indexed parameter
# → use agentId for reputation queries, reviews, and feedback
```

## Transaction mode

In the default `dry-run` mode, write commands preview and need `--broadcast` to execute. `agent mode auto` persists always-broadcast; `--dry-run` on any command forces a preview regardless of mode. After the first `wallet login --owner`, if the output has a `modePrompt` field, ask the user and run `agent mode auto` or `agent mode dry-run` per their answer. Never enable auto mode without the user's explicit answer.

## Environment Variables

### OMS credentials (optional)

No setup step is required. The CLI ships a default OMS publishable key, and `wallet login` automatically provisions a dedicated Builder project and access key on first login, saving it to `~/.polygon-agent/builder.json`.

| Variable | Description |
|----------|-------------|
| `OMS_PUBLISHABLE_KEY` | Advanced override: point at your own OMS Builder project instead of the default |

Set it via env, or persist once with `setup` so every command reads it from `~/.polygon-agent/builder.json`:
```bash
agent setup --oms-publishable-key <key>
```

`--oms-project-id <proj_...>` is also accepted but optional — it's kept only as legacy display metadata. Plain `setup` (no key) still works for manual or `--force` re-provisioning.

### Optional overrides
| Variable | Default |
|----------|---------|
| `POLYGON_AGENT_SIGNIN` | `browser` or `email`: forces the sign-in method for session mode instead of the automatic pick |
| `POLYGON_AGENT_LOGIN_UI` | Base URL of the browser login page opened by `wallet login` (default `https://agentconnect.polygon.technology`) |
| `POLYGON_AGENT_CREDENTIALS_URL` | Base URL of the site that keeps saved details (address, cards, buying) and shows the dashboard (default: the login page's site) |
| `POLYGON_AGENT_OIDC_RELAY` | Base URL of the OIDC relay used by `wallet login` (default `https://oidc-relay.polygon.technology`); also settable per run with `--relay-url` |
| `SEQUENCE_PROJECT_ACCESS_KEY` | Used only as the Trails API key for DeFi earn-pool lookups (optional) |
| `TRAILS_TOKEN_MAP_JSON` | Token-directory lookup |
| `POLYGON_AGENT_DEBUG_FETCH` | Off — logs HTTP to `~/.polygon-agent/fetch-debug.log` |
| `POLYGON_AGENT_DEBUG_FEE` | Off — dumps fee options to stderr |

## File Structure
```
~/.polygon-agent/
├── .encryption-key       # AES-256-GCM key (auto-generated, 0600)
├── config.json           # transaction mode (auto | dry-run)
├── builder.json          # publishableKey, omsProjectId, access key
├── polymarket/<wallet>/  # Polymarket trading key, builder key, account (encrypted)
├── wallets/<name>.json   # agent wallet pointer: walletAddress, loginMethod, access (owner | session)
├── oms/<name>/           # OMS SDK session storage + encrypted credential key (owner mode)
├── session/<name>/       # session key, approved plan, USD ledger (session mode)
├── trades/               # swap state by intent id
└── watches.json, alerts.jsonl, watch-state.json
```

A workspace install keeps all of this under `<workspace>/.polygon-agent/state/` (`POLYGON_AGENT_HOME`).
