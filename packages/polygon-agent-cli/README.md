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
  - [Trails: Swapping, Bridging, and onchain actions](#trails-swapping-bridging-and-defi-actions)
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

### Recommended: Install on your agent

Install the Polygon Agent CLI as a skill your agent can use — works with Claude Code, Codex, Openclaw, and any agent harness that supports the skills protocol:

```bash
npx skills add https://github.com/0xPolygon/polygon-agent-cli
```

Once installed, your agent has access to wallet management, token operations, DEX swaps, and on-chain identity, all through the `polygon-agent` CLI.

### Manual Install

**npm (global):**

```bash
npm install -g @polygonlabs/agent-cli
```

**From source** — for contributors or local development. Use `pnpm polygon-agent` instead of `polygon-agent` for all commands.

```bash
git clone https://github.com/0xPolygon/polygon-agent-cli.git
cd polygon-agent-cli
pnpm install
pnpm polygon-agent --help
```

### After install: get your agent running

Once installed via skills or npm, run the following. If running from source, prefix `polygon-agent` commands with `pnpm` and run them from the root of the repository (e.g., `pnpm polygon-agent setup --name "MyAgent"`).

```bash
# 1. Setup: save your OMS Builder publishable key (persisted to ~/.polygon-agent/builder.json)
polygon-agent setup --oms-publishable-key <key>

# 2. Log in to your embedded wallet in the browser
polygon-agent wallet login
# Prints a login page URL and opens it in a browser. Choose Google or email
# on the page; once you finish, the embedded wallet is created or unlocked.
# This works whether the browser is on this machine or elsewhere, so there
# is no separate remote mode to enable. Use --local for the older loopback
# flow, which needs the browser on this same machine.

# 3. Fund the wallet
polygon-agent fund

# 4. Start operating
polygon-agent balances
polygon-agent send --to 0x... --amount 1.0
polygon-agent swap --from USDC --to USDT --amount 5

# 5. Register your agent on-chain
polygon-agent agent register --name "MyAgent"
```

> Omit `--broadcast` on any command to preview without sending. See [`QUICKSTART.md`](skills/QUICKSTART.md) for the full step-by-step walkthrough.

---

## Core Components

The CLI is built on three pillars to enable end to end onchain payments with your agents.

### OMS: Wallet Infrastructure

[OMS (Open Money Stack)](https://sequence.xyz) powers all wallet operations, RPC access, and indexing.

| Capability  | What it does                                                                                | CLI command                     |
| ----------- | ------------------------------------------------------------------------------------------- | ------------------------------- |
| **Wallets** | browser-login embedded smart wallets (Account Abstraction), chain-agnostic address           | `wallet login`, `wallet list`   |
| **RPCs**    | Load balanced RPCs cross-chain for onchain interactions and node queries                    | Used internally by all commands |
| **Indexer** | Token balance queries and transaction history across ERC-20/721/1155                        | `balances`                      |

Wallets are created and unlocked via browser login (Google or email). The embedded wallet can call any contract and spend any amount it holds; there is no contract whitelist or per-token spend limit. The wallet address is the same across every supported chain, and sessions last about a week before you re-run `wallet login`.

### Trails: Swapping, Bridging, and DeFi Actions

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
| **Skills** (Claude Code, Codex, Openclaw, etc.) — recommended | `npx skills add https://github.com/0xPolygon/polygon-agent-cli` |

Once installed, the agent receives the full skill context — including wallet setup, token operations, and ERC-8004 registration, and can execute autonomously.

See [`SKILL.md`](skills/SKILL.md) for the full agent-consumable reference and [`QUICKSTART.md`](skills/QUICKSTART.md) for the 4-phase setup guide.

---

## CLI Reference

### Setup & Wallets

```bash
polygon-agent setup --oms-publishable-key <key>  # Save OMS Builder credentials
polygon-agent wallet login [--name <n>] [--local] [--no-fund] [--force]  # Log in from the browser (choose Google or email on the login page)
polygon-agent wallet logout [--name <n>]           # Log out of a wallet
polygon-agent wallet list                          # Show all wallets
polygon-agent wallet address [--name <n>]          # Show wallet address (same on every chain)
polygon-agent wallet remove [--name <n>]           # Remove a stored wallet
polygon-agent fund                                 # Open funding widget
```

### Token Operations

```bash
polygon-agent balances                             # Balances on session default chain
polygon-agent balances --chain arbitrum            # Single chain override
polygon-agent balances --chains polygon,base,arbitrum  # Same wallet, multiple chains (JSON)
polygon-agent send --to 0x... --amount 1.0         # Send POL (dry-run)
polygon-agent send --symbol USDC --to 0x... --amount 10 --broadcast
polygon-agent swap --from USDC --to USDT --amount 5 --broadcast
polygon-agent withdraw --position <aToken-or-vault> --amount max [--chain <chain>]   # dry-run; add --broadcast
polygon-agent withdraw --position <aToken> --amount 0.5 --chain mainnet --broadcast   # partial (underlying units)
polygon-agent call --to 0x... --data 0x... [--value <amt>] [--prefer-native-fee] [--broadcast]   # arbitrary contract call
```

**`withdraw`** exits **Aave v3** positions using your **aToken** address (`POOL()` + `UNDERLYING_ASSET_ADDRESS()` → `Pool.withdraw`), or **ERC-4626** vaults (e.g. Morpho) via `redeem`. Dry-run prints `poolAddress` / `vault` and calldata.

The embedded wallet can call any contract on any chain, so no pre-authorization is needed — just ensure the wallet holds a little POL or USDC for gas on the target chain. To transact on a chain other than Polygon, pass `--chain <name>` on the command itself.

**`call`** sends a raw transaction to any contract. The relayer takes its gas fee in USDC or POL, whichever the wallet can afford; for a native-only wallet, pass `--prefer-native-fee`.

### Agent Registry (ERC-8004)

```bash
polygon-agent agent register --name "MyAgent" --broadcast
polygon-agent agent reputation --agent-id <id>
polygon-agent agent feedback --agent-id <id> --value 4.5 --broadcast
polygon-agent agent reviews --agent-id <id>
```

### Smart Defaults

| Default       | Value                  | Override             |
| ------------- | ---------------------- | -------------------- |
| Wallet name   | `main`                 | `--name <name>`      |
| Chain         | `polygon`              | `--chain <name\|id>` |
| Multi-chain balances | —                 | `--chains <csv>` (comma-separated, max 20; overrides `--chain`) |
| Broadcast     | Dry-run (preview)      | `--broadcast`        |

---

## Environment Variables

**Required credential** comes from the [OMS Builder](https://sequence.build) dashboard. Pass it to `setup` (which persists it to `~/.polygon-agent/builder.json`), or export it:

```bash
export SEQUENCE_PUBLISHABLE_KEY=<publishable-key-from-builder>
```

**Optional:**

| Variable                   | Default                                    | Description                                                                    |
| -------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- |
| `TRAILS_API_KEY`           | —                                           | Optional Trails API key for higher rate limits on swap / bridge / earn calls.   |
| `POLYGON_AGENT_LOGIN_UI`   | `https://agentconnect.polygon.technology`   | Base URL of the browser login page opened by `wallet login`.                   |
| `POLYGON_AGENT_OIDC_RELAY` | `https://oidc-relay.polygon.technology`     | Base URL of the OIDC handoff and login relay used by `wallet login`.           |

---

## Security

- **No keys to manage.** The embedded wallet is unlocked via browser login (Google or email); there are no private keys exposed to the agent's context. Credentials are stored in `~/.polygon-agent/`.
- **Sessions expire.** Wallet sessions last about a week, after which you re-run `wallet login`.

---

## Troubleshooting

| Issue                                       | Fix                                              |
| ------------------------------------------- | ------------------------------------------------ |
| Missing OMS Builder credential               | Run `setup` with `--oms-publishable-key`, or export `SEQUENCE_PUBLISHABLE_KEY` |
| Not logged in                               | Run `polygon-agent wallet login`                 |
| Session expired                             | Run `polygon-agent wallet login`                 |
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
│       │   ├── commands/   # Command modules (setup, wallet, operations, agent)
│       │   ├── lib/        # Shared utils (storage, ethauth, tokens)
│       │   └── types.d.ts  # Ambient declarations for untyped deps
│       ├── contracts/      # ERC-8004 ABIs
│       └── skills/         # Agent-friendly docs (SKILL.md, QUICKSTART.md)
├── pnpm-workspace.yaml
└── package.json
```

**Requirements:** Node.js 20+

---

## License

MIT
