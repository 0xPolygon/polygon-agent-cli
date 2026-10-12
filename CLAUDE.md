# Polygon Agent CLI

## Team Standards

Fetch and apply the Polygon Apps Team standards:

@https://gist.githubusercontent.com/MaximusHaximus/4eb35e807f7470b1c4eab78a9152b2ef/raw/team-standards.md

## Repository Structure

This is a pnpm workspace monorepo. The primary package is:

- `packages/polygon-agent-cli/` — CLI tool for on-chain agent operations on Polygon

Wallets use the OMS (Open Money Stack) V3 embedded-wallet model (`@polygonlabs/oms-wallet`,
`OMSWallet`): the CLI authenticates via browser login with Google or email (`wallet login`) and
holds the credential on disk.

Static assets: ABI JSON in `contracts/` is published with the CLI package (it is in
`package.json` `files`); Claude skills live in the root `skills/` tree (one directory per
skill) and are distributed via `npx skills add` and agentconnect, not via npm.

## Development

- Dev environment requires Node 24+ (`.nvmrc`). The published CLI supports Node 22+.
- `tsx packages/polygon-agent-cli/src/index.ts` runs the CLI directly from source (tsx handles `.js`→`.ts` remapping for workspace packages).
- `pnpm run build` compiles TypeScript to `dist/` (targeting es2023 for Node 22 compat).
- The CLI uses yargs with the `CommandModule` builder/handler pattern.

## Key Directories

- `packages/polygon-agent-cli/src/commands/` — yargs command modules
- `packages/polygon-agent-cli/src/lib/` — shared utilities (storage, oms-client, oms-tx, oms-storage, tx-dispatch, token-directory, ethauth)
- `packages/polygon-agent-cli/src/types.d.ts` — ambient declarations for untyped dependencies

## Wallet auth (OMS V3)

- `agent wallet login` (bare) connects the agent wallet in session mode: the owner signs in once to approve a limited allowance (`--allowance`, `--days`, `--chains`) for this install's own key, and the sign-in is revoked. The CLI picks the method automatically: the browser login page (a detached background waiter drives it; `wallet login --wait` collects the result) or a code emailed to the owner and pasted into chat (`--email <email>` forces it; `POLYGON_AGENT_SIGNIN=email|browser` overrides the pick). Allowance, withdraw and access changes are owner requests that use the same picker.
- `agent wallet login --owner`: the full owner session. Opens the agentconnect login page (`POLYGON_AGENT_LOGIN_UI`, default `https://agentconnect.polygon.technology`), where the user chooses Google or email; works whether the browser is local or remote. `--local` falls back to the older loopback flow (raw Google URL + localhost callback; browser must be on this machine). `--remote` is deprecated now that the default flow already works remotely. Relay base URL is `POLYGON_AGENT_OIDC_RELAY` or `--relay-url` (default `https://oidc-relay.polygon.technology`). Other flags: `--name <n>` (default "main"), `--no-fund`, `--force`. Session persists ~1 week under `~/.polygon-agent/oms/<name>/`.
- No setup step is required: the CLI ships a default `OMS_PUBLISHABLE_KEY`, and `wallet login` auto-provisions a Builder project + access key on first login, saving it to `~/.polygon-agent/builder.json`. `OMS_PUBLISHABLE_KEY` (env) and `setup --oms-publishable-key` remain as advanced overrides for developers pointing at their own OMS project; plain `setup` remains for manual or `--force` re-provisioning.
- `lib/tx-dispatch.ts` `runTx` is the single tx primitive (wraps `runOmsTx`). All commands submit through it.

## Saved credentials (agentconnect)

- The agentconnect worker (`packages/agentconnect-ui/worker/`) serves `/api/agent/enroll` and `/api/credentials/address`. Saved details are one Workers KV record per wallet (`CREDENTIALS` binding, key `wallet:<lowercase address>`), sealed with AES-GCM under a key derived from `CREDENTIALS_KEY` (`worker/store.ts`). OMS customers were the first choice but need full KYC (SSN, date of birth) and reject `metadata` in v0.13.
- Agent sign-in: during any owner sign-in the CLI asks OMS for an ID token (`getIdToken`, custom claims `agent_key` + `purpose: agentconnect-enroll`). The worker verifies it against the OMS JWKS and returns a 30-day HMAC certificate. The agent then signs its own short-lived `at1` tokens (`lib/credentials/agent.ts`) for API calls and in dashboard links (`#t=` fragment, 1 hour). Token formats are mirrored in `worker/agent-auth.ts`.
- Cards: `/api/credentials/cards` and `/api/credentials/cards/session` create AgentCard vault sessions (hosted page, passkey) and list display fields. The vault user ids for a wallet are kept in its KV record (`agentcardUsers`). AgentCard reports a session `linked` once the passkey user exists; the card is only stored when the session shows `card: true`, so callers wait for `cardSaved`.
- Worker secrets are GitHub environment secrets, uploaded by the deploy workflow with `wrangler deploy --secrets-file`: `AGENT_CERT_SECRET`, `CREDENTIALS_KEY`, `AGENTCARD_CLIENT_ID`, `AGENTCARD_CLIENT_SECRET`. The KV namespace has no id in `wrangler.toml`; wrangler creates it on the first deploy.
