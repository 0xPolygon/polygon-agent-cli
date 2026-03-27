# Polygon Agent CLI

## Team Standards

Fetch and apply the Polygon Apps Team standards:

@https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md

## Repository Structure

This is a pnpm workspace monorepo with two packages:

- `packages/polygon-agent-cli/` — CLI tool for on-chain agent operations on Polygon
- `packages/connector-ui/` — Wallet connector UI (Vite + React frontend)

Static assets (ABI JSON in `contracts/`, Claude skills in `skills/`) are
published with the CLI package but are not source code.

## Development

- Dev environment requires Node 24+ (`.nvmrc`). The published CLI supports Node 20+.
- `tsx packages/polygon-agent-cli/src/index.ts` runs the CLI directly from source (tsx handles `.js`→`.ts` remapping for workspace packages).
- `pnpm run build` compiles TypeScript to `dist/` (targeting es2023 for Node 20 compat).
- The CLI uses yargs with the `CommandModule` builder/handler pattern.

## Key Directories

- `packages/polygon-agent-cli/src/commands/` — yargs command modules
- `packages/polygon-agent-cli/src/lib/` — shared utilities (storage, dapp-client, token-directory, ethauth)
- `packages/polygon-agent-cli/src/types.d.ts` — ambient declarations for untyped dependencies
