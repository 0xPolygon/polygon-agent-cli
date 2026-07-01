# Polygon Agent CLI

## Team Standards

Fetch and apply the Polygon Apps Team standards:

@https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md

## Repository Structure

This is a pnpm workspace monorepo. The primary package is:

- `packages/polygon-agent-cli/` — CLI tool for on-chain agent operations on Polygon

Wallets use the Sequence V3 embedded-wallet model (`@0xsequence/typescript-sdk`,
`OMSClient`): the CLI authenticates via Google browser login (`wallet login`) and
holds the credential on disk.

Static assets (ABI JSON in `contracts/`, Claude skills in `skills/`) are
published with the CLI package but are not source code.

## Development

- Dev environment requires Node 24+ (`.nvmrc`). The published CLI supports Node 20+.
- `tsx packages/polygon-agent-cli/src/index.ts` runs the CLI directly from source (tsx handles `.js`→`.ts` remapping for workspace packages).
- `pnpm run build` compiles TypeScript to `dist/` (targeting es2023 for Node 20 compat).
- The CLI uses yargs with the `CommandModule` builder/handler pattern.

## Key Directories

- `packages/polygon-agent-cli/src/commands/` — yargs command modules
- `packages/polygon-agent-cli/src/lib/` — shared utilities (storage, oms-client, oms-tx, oms-storage, tx-dispatch, token-directory, ethauth)
- `packages/polygon-agent-cli/src/types.d.ts` — ambient declarations for untyped dependencies

## Wallet auth (Sequence V3 / OMS)

- `polygon-agent wallet login` — logs in with Google in the browser; prints/opens a Google sign-in URL, and once you sign in the embedded wallet is created/unlocked. Add `--remote` for headless hosts (uses a public OIDC relay; needs `POLYGON_AGENT_OIDC_RELAY` or `--relay-url`). Other flags: `--name <n>` (default "main"), `--no-fund`, `--force`. Session persists ~1 week under `~/.polygon-agent/oms/<name>/`.
- Requires `SEQUENCE_PUBLISHABLE_KEY` + `SEQUENCE_OMS_PROJECT_ID` (from Sequence Builder), via env or `builder.json` (set with `setup --oms-publishable-key/--oms-project-id`).
- `lib/tx-dispatch.ts` `runTx` is the single tx primitive (wraps `runOmsTx`). All commands submit through it.
