# Polygon Agent CLI - Agent Instructions

## Project Overview

This is a **pnpm workspace monorepo** for building on-chain agents on Polygon.

### Packages

- **`packages/polygon-agent-cli/`** — CLI tool for on-chain agent operations
  - Entry: `src/index.ts`
  - Commands: `agent.ts`, `agent-legacy.ts`, `operations.ts`, `setup.ts`, `wallet.ts`
  - Lib utilities: `dapp-client.ts`, `ethauth.ts`, `storage.ts`, `token-directory.ts`, `utils.ts`
  - Contract ABIs: `contracts/IdentityRegistry.json`, `contracts/ReputationRegistry.json`

- **`packages/connector-ui/`** — Wallet connector UI (Vite + React)
  - Standard Vite React app with TypeScript
  - Deployed via Cloudflare Workers

## Development Standards

### Requirements

- **Node.js**: 24+ (see `.nvmrc`)
- **Package Manager**: pnpm 10.30.3

### Key Commands

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Run type checking
pnpm run typecheck

# Run linting
pnpm run lint

# Run CLI from source
pnpm run polygon-agent
# or
node packages/polygon-agent-cli/src/index.ts
```

### Code Style

- TypeScript with strict configuration
- ESLint with `@polygonlabs/apps-team-lint` config
- Prettier for formatting
- Conventional commits with commitlint

### Architecture

- CLI uses **yargs** with `CommandModule` builder/handler pattern
- Commands located in `src/commands/`
- Shared utilities in `src/lib/`
- Static assets (ABIs, skills) published with CLI but not source code

## Working with This Codebase

### Adding New Commands

1. Create new file in `packages/polygon-agent-cli/src/commands/`
2. Export a yargs `CommandModule` with `command`, `describe`, `builder`, and `handler`
3. Import and register in `src/index.ts`

### Adding Contract ABIs

1. Add JSON file to `packages/polygon-agent-cli/contracts/`
2. Reference in code as needed

### Connector UI Changes

1. UI code in `packages/connector-ui/src/`
2. Config in `packages/connector-ui/src/config.ts`
3. Deploy via `wrangler deploy` (see `.github/workflows/deploy-connector-ui.yml`)

## Important Notes

- **Never commit secrets**: `.env` files, private keys, API keys
- **Build before testing**: Run `pnpm run build` after changes
- **Follow existing patterns**: Check similar commands/files before implementing new features
- **Type safety**: All code must pass `pnpm run typecheck`

## Resources

- Team standards: See CLAUDE.md (fetched from gist)
- Releasing: See `docs/RELEASING.md`
- CLI Skills: See `packages/polygon-agent-cli/skills/SKILL.md`
