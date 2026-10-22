# Polygon Agent CLI

<p align="center">
  <img src="https://raw.githubusercontent.com/0xPolygon/polygon-agent-cli/main/assets/agents-cli-image.png" alt="Polygon Agent CLI" width="700" />
</p>

<p align="center">
  <strong>End-to-end blockchain toolkit for AI agents on Polygon.</strong><br/>
  Give your agent wallets, tokens, swaps, and on-chain identity. One install.
</p>

---

## Table of Contents

- [Overview](#overview)
- [Quickstart](#quickstart)
- [Core Components](#core-components)
  - [OMS: Wallet Infrastructure](#oms-wallet-infrastructure)
  - [Swap, Bridge & Deposit](#swap-bridge--deposit)
  - [Onchain Identity](#onchain-agentic-identity)
- [Plugins & Skills](#plugins--skills)
- [CLI Reference](#cli-reference)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

---

## Overview

Polygon Agent CLI gives AI agents everything they need to operate onchain:

- **Create and manage wallets** browser-login embedded smart wallets, no private keys to manage and no keys exposed to your agent's context.
- **Send tokens, swap, bridge or any action** pay in any token for any onchain action. Built-in swapping, bridging, deposits, DeFi primitives, and more.
- **Register agent identity** and build reputation via ERC-8004
- **Integrated APIs** query cross-chain balances, transaction history and or query nodes via dedicated RPCs
- **Payments first** native gas abstraction built-in, pay end to end in stablecoins for interactions.

---

## Quickstart

### Personal assistants (Muse, OpenClaw, Hermes, Claude Code, Codex, Cursor)

Give your assistant this link and ask it to set up your wallet:

```
https://agents.polygon.technology/skill.md
```

That page is the Open Money Agent skill. It installs the CLI into the assistant's workspace with the same skill, matched to the CLI's version, and connects your wallet with a spending allowance you approve by signing in. The skill is a short index: each use case (Polymarket, trading, yield, price watches, x402 services, the full CLI reference) is a reference it opens only when a task needs it.

### Install as a skill

Install the Polygon Agent CLI as a skill your agent can use — works with Claude Code, Codex, Openclaw, and any agent harness that supports the skills protocol:

```bash
npx skills add https://github.com/0xPolygon/polygon-agent-cli
```

Once installed, your agent has access to wallet management, token operations, DEX swaps, and on-chain identity, all through the `agent` CLI. The long-form `polygon-agent` command name remains available as an alias, so both work.

### Manual Install

**npm (global):**

```bash
npm install -g @polygonlabs/agent-cli
```

**From source** — for contributors or local development. Use `pnpm polygon-agent` instead of `agent` for all commands.

```bash
git clone https://github.com/0xPolygon/polygon-agent-cli.git
cd polygon-agent-cli
pnpm install
pnpm polygon-agent --help
```

### After install: get your agent running

Once installed via skills or npm, run the following. If running from source, run `agent` commands via `pnpm polygon-agent` from the root of the repository (e.g., `pnpm polygon-agent setup --name "MyAgent"`).

```bash
# 1. Connect your wallet
agent wallet login
# Session mode: you sign in once (an emailed code, or the login page in a
# browser) to approve a spending allowance for this install, by default
# $1000 over 30 days (--allowance, --days). The agent spends only within it,
# and your sign-in isn't kept. Anything beyond it asks you to sign in again.
#
# agent wallet login --owner keeps the full owner sign-in instead (about a
# week, no allowance limit), for a machine you control.
#
# No setup step needed: the CLI ships a default OMS Builder publishable key,
# and login automatically provisions your own Builder project + access key
# (saved to ~/.polygon-agent/builder.json) for indexer and Trails quota.

# 2. Fund the wallet
agent fund

# 3. Start operating
agent balances
agent send --to 0x... --amount 1.0
agent swap --from USDC --to USDT --amount 5

# 4. Register your agent on-chain
agent register --name "MyAgent" --broadcast
```

> Write commands preview by default — omit `--broadcast` to dry-run, or run `agent mode auto` once to always broadcast (`--dry-run` still previews any single command). The skill lives in [`skills/open-money-agent/`](https://github.com/0xPolygon/polygon-agent-cli/tree/main/skills/open-money-agent) and ships inside the CLI package: `SKILL.md` is the index, and `references/` holds one file per use case (`connect`, `wallet`, `trade`, `earn`, `watches`, `polymarket`, `paid-services`, `identity`, `platforms`, `developer`, `cli-reference`, `troubleshooting`). `agent skills show open-money-agent` prints the index and `agent skills show <topic>` prints a reference. The old skill names (`polygon-agent-wallet`, `polygon-polymarket`, `polygon-defi`, `polygon-discovery`, `polygon-agent-cli`) still work there.

### Workspace installs

For assistants that keep a workspace folder across restarts, the CLI can live inside it instead of being installed globally:

```bash
npm install --ignore-scripts --prefix <workspace>/.polygon-agent/cli @polygonlabs/agent-cli@latest
node <workspace>/.polygon-agent/cli/node_modules/@polygonlabs/agent-cli/dist/index.js \
  workspace init --root <workspace>/.polygon-agent [--skills-dir <dir>] [--name <install name>]
```

`workspace init` writes a wrapper at `<workspace>/.polygon-agent/bin/polygon-agent` that runs the CLI with its state in `<workspace>/.polygon-agent/state/`, a `.gitignore` that keeps the folder out of git, and `state/install.json`. Run everything through the wrapper. It is safe to re-run.

- `skills show <name>` prints a bundled skill; `skills install [name] --dir <dir>` writes it to `<dir>/<name>/SKILL.md`. Through the wrapper, both add the wrapper's path to the skill.
- `update` installs the latest CLI into the workspace and refreshes it. Outside a workspace install, it prints the global npm command.

---

## Core Components

The CLI is built on three pillars to enable end to end onchain payments with your agents.

### OMS: Wallet Infrastructure

[OMS (Open Money Stack)](https://sequence.xyz) powers all wallet operations, RPC access, and indexing.

| Capability  | What it does                                                                                | CLI command                     |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| **Wallets** | embedded smart wallets (Account Abstraction), chain-agnostic address, with a spending allowance per install | `wallet login`, `wallet status` |
| **RPCs**    | Load balanced RPCs cross-chain for onchain interactions and node queries                    | Used internally by all commands |
| **Indexer** | Token balance queries and transaction history across ERC-20/721/1155                        | `balances`                      |

Wallets are created and unlocked by signing in with an emailed code or on the login page (Google or email). By default an install connects in session mode: it holds its own key, limited to the allowance the owner approved, and the owner's sign-in isn't kept. Owner mode (`wallet login --owner`) keeps the full sign-in for about a week, with no spend limit. The wallet address is the same across every supported chain.

### Swap, Bridge & Deposit

[Trails](https://sequence.xyz/trails) handles swapping, bridging, and onchain interactions enabling you to call any smart contract function and pay with any token. Trails handles it under the hood in a single transaction for your agent.

| Capability   | What it does                                                                                 | CLI command                     |
| ------------ | -------------------------------------------------------------------------------------------- | ------------------------------- |
| **Bridging** | Move assets cross-chain into your Polygon wallet and fund the initial flows to your wallet   | `fund`                          |
| **Swapping** | Token swaps with configurable slippage seamlessly built in                                   | `swap`                          |
| **Actions**  | Composable onchain operations (deposit / withdraw from yield, send tokens) | `send`, `deposit`, `withdraw`, `send-token` |

### Onchain Agentic Identity

Native contracts for agent identity, reputation, and emerging payment standards.

| Capability      | What it does                                                                     | CLI command                                            |
| --------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **ERC-8004**    | Register agents as ERC-721 NFTs with metadata and on-chain reputation            | `agent register`, `agent reputation`, `agent feedback` |
| **x402**        | HTTP-native micropayment protocol for agentic payments to your favorite services | `x402-pay`                                             |
| **Native Apps** | Direct interaction with any smart contract                                       | `call`                                                 |

**ERC-8004 contracts on Polygon:**

- Identity Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- Reputation Registry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

---

## Plugins & Skills

The CLI ships with agent-friendly documentation designed to be consumed directly by AI agents.

| Distribution                                | How to install                                              |
| ------------------------------------------- | ----------------------------------------------------------- |
| **Personal assistants** — recommended | Give the assistant `https://agents.polygon.technology/skill.md` |
| **Skills** (Claude Code, Codex, Openclaw, etc.) | `npx skills add https://github.com/0xPolygon/polygon-agent-cli` |

Once installed, the agent receives the full skill context — including wallet setup, token operations, and ERC-8004 registration, and can execute autonomously.

See the Open Money Agent skill ([`skills/open-money-agent/`](https://github.com/0xPolygon/polygon-agent-cli/tree/main/skills/open-money-agent)) for the agent-facing guide; every command is in its [CLI reference](https://github.com/0xPolygon/polygon-agent-cli/blob/main/skills/open-money-agent/references/cli-reference.md).

---

## CLI Reference

### Setup & Wallets

```bash
agent wallet login [--allowance <usd>] [--days <n>] [--email <email>] [--name <n>]  # Session mode: approve an allowance by emailed code or login page
agent wallet login --owner [--local] [--no-fund] [--force] [--name <n>]  # Owner mode: keep the full sign-in (about a week)
agent wallet status [--name <n>]           # Connected? Mode, allowance left
agent setup --oms-publishable-key <key>  # Advanced: point at your own OMS Builder project instead of the default
agent wallet logout [--name <n>]           # Log out of a wallet
agent wallet list                          # Show all wallets
agent wallet address [--name <n>]          # Show wallet address (same on every chain)
agent wallet remove [--name <n>]           # Remove a stored wallet
agent fund                                 # Open funding widget
agent mode [auto|dry-run]                  # Show or set the persisted transaction mode
```

### Token Operations

```bash
agent balances                             # Balances on session default chain
agent balances --chain arbitrum            # Single chain override
agent balances --chains polygon,base,arbitrum  # Same wallet, multiple chains (JSON)
agent send --to 0x... --amount 1.0         # Send POL (dry-run)
agent send --symbol USDC --to 0x... --amount 10 --broadcast
agent swap --from USDC --to USDT --amount 5 --broadcast
agent withdraw --position <aToken-or-vault> --amount max [--chain <chain>]   # dry-run; add --broadcast
agent withdraw --position <aToken> --amount 0.5 --chain mainnet --broadcast   # partial (underlying units)
agent call --to 0x... --data 0x... [--value <amt>] [--prefer-native-fee] [--broadcast]   # arbitrary contract call
```

**`withdraw`** exits **Aave v3** positions using your **aToken** address (`POOL()` + `UNDERLYING_ASSET_ADDRESS()` → `Pool.withdraw`), or **ERC-4626** vaults (e.g. Morpho) via `redeem`. Dry-run prints `poolAddress` / `vault` and calldata.

The embedded wallet can call any contract on any chain, so no pre-authorization is needed — just ensure the wallet holds a little POL or USDC for gas on the target chain. To transact on a chain other than Polygon, pass `--chain <name>` on the command itself.

**`call`** sends a raw transaction to any contract. The relayer takes its gas fee in USDC or POL, whichever the wallet can afford; for a native-only wallet, pass `--prefer-native-fee`.

### Agent Registry (ERC-8004)

```bash
agent register --name "MyAgent" --broadcast
agent identity --agent-id <id>                       # payment wallet (+ --key for metadata)
agent reputation --agent-id <id>
agent feedback --agent-id <id> --value 4.5 --broadcast
agent reviews --agent-id <id> [--include-revoked]
```

### Polymarket

```bash
agent polymarket status                    # start here
agent polymarket setup --broadcast         # create the account; no POL needed
agent polymarket deposit 25 --broadcast    # USDC from the OMS wallet; minimum $2
agent polymarket markets --search "election"
agent polymarket buy <ref> <outcome> 5 --max-price 0.6 --broadcast
agent polymarket sell <ref> <outcome> all --min-price 0.4 --broadcast
agent polymarket redeem --all --broadcast
agent polymarket withdraw all --broadcast  # back to the OMS wallet as USDC
```

Markets are named by conditionId, market slug, or event slug plus outcome name (`"Bob"`, `"Bob no"`). Write commands preview unless you pass `--broadcast`. See `skills/open-money-agent/references/polymarket.md` for the full guide.

Polymarket commands run on Node 22 and 24. `@polymarket/client` declares Node 24 in `engines`, so `npm install` on Node 22 may print an `EBADENGINE` warning. It is safe to ignore.

### Smart Defaults

| Default       | Value                  | Override             |
| ------------- | ---------------------- | -------------------- |
| Wallet name   | `main`                 | `--name <name>`      |
| Chain         | `polygon`              | `--chain <name\|id>` |
| Multi-chain balances | —                 | `--chains <csv>` (comma-separated, max 20; overrides `--chain`) |
| Tx mode       | `dry-run` (preview)    | `--broadcast`, `--dry-run`, or persist with `agent mode auto` |

---

## Environment Variables

No environment variables are required. The CLI ships a default OMS Builder publishable key, and `wallet login` automatically provisions your own Builder project and access key on first login, saving it to `~/.polygon-agent/builder.json`.

**Advanced overrides:**

| Variable                   | Default                                    | Description                                                                    |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `OMS_PUBLISHABLE_KEY` | Baked-in default                            | Point at your own OMS Builder project instead of the default. Can also be set via `setup --oms-publishable-key <key>` (persists to `~/.polygon-agent/builder.json`). |
| `TRAILS_API_KEY`           | —                                           | Optional Trails API key for higher rate limits on swap / bridge / earn calls.   |
| `POLYGON_AGENT_LOGIN_UI`   | `https://agentconnect.polygon.technology`   | Base URL of the browser login page opened by `wallet login`.                   |
| `POLYGON_AGENT_OIDC_RELAY` | `https://oidc-relay.polygon.technology`     | Base URL of the OIDC handoff and login relay used by `wallet login`.           |
| `POLYGON_AGENT_HOME`       | `~/.polygon-agent`                          | Folder for all CLI state (wallets, keys, config). Set by a workspace install's wrapper. |

---

## Security

- **No keys to manage.** The embedded wallet is unlocked by signing in (emailed code, or Google or email on the login page); no private keys are exposed to the agent's context. Credentials are stored encrypted in `~/.polygon-agent/`.
- **Spending is capped.** In session mode the agent spends only within the allowance the owner approved. Raising it, withdrawing to an outside address, or managing access needs a new sign-in.
- **Sessions expire.** An allowance lasts its period (30 days by default); an owner sign-in lasts about a week. Then re-run `wallet login`.

---

## Troubleshooting

| Issue                                       | Fix                                              |
| ------------------------------------------- | ------------------------------------------------ |
| Builder provisioning failed during login (see the stderr note) | It retries on the next `wallet login`; or run `setup` manually. Custom projects: export `OMS_PUBLISHABLE_KEY` |
| Not logged in                               | Run `agent wallet login`                 |
| Session expired                             | Run `agent wallet login`                 |
| Insufficient funds / can't pay gas          | Run `fund`; for a native-only wallet pass `--prefer-native-fee` on `call` |
| Transaction failed                          | Omit `--broadcast` to dry-run first              |

---

## Development

```bash
# Install dependencies
pnpm install

# CLI (via root script)
pnpm polygon-agent --help
```

### Project Structure

```text
polygon-agent-cli/
├── packages/
│   └── polygon-agent-cli/  # CLI package (@polygonlabs/agent-cli)
│       ├── src/            # TypeScript source
│       │   ├── index.ts    # yargs entry point
│       │   ├── commands/   # Command modules (setup, mode, wallet, operations, agent)
│       │   ├── lib/        # Shared utils (storage, mode, ethauth, tokens)
│       │   └── types.d.ts  # Ambient declarations for untyped deps
│       └── contracts/      # ERC-8004 ABIs
├── skills/                 # Agent skills (SKILL.md per skill; served via agentconnect)
├── pnpm-workspace.yaml
└── package.json
```

**Requirements:** Node.js 22+

---

## License

MIT
