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
`package.json` `files`).

Skills: one skill, AgentPay, in `skills/agentpay/`. `SKILL.md` is the index every agent reads
(kept under 12 KB): check the CLI is installed, run `wallet status` first, then route
the request to `references/<topic>.md`, loaded only for that task. Each reference opens with a
title and a `**When to use:**` line; only the index has frontmatter. `src/lib/skills.test.ts`
(CLI package) enforces this, and that every reference is linked from the index. The CLI bundles
the folder (`scripts/build.mjs`), `workspace init` installs it with its references, and
`skills show <topic>` prints a reference (old skill names map to topics). The agentconnect site
serves the index at `/skill.md` (the URL assistants are given), `/SKILL.md`, `/setup.md`, `/agentpay/SKILL.md` and every older skill URL, and
the references at `/references/` too (`vite.config.ts`). Also distributed via `npx skills add`
and the plugins, not via npm on its own.

Plugins: the repo is a plugin marketplace for Claude Code (`.claude-plugin/marketplace.json`),
Codex (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) and Cursor
(`.cursor-plugin/marketplace.json`). Each points at `plugins/agentpay/`, whose `skills` and
`assets` are symlinks to the root folders, so a skill edit needs no plugin change. The manifests
carry no `version`, so installs update with each commit. Check with `claude plugin validate .`.

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
- Site sign-in: the dashboard's own sign-in (email code or Google) runs in the worker (`/api/session/*`, reusing `worker/owner-signin.ts`) and sets an HttpOnly `agentconnect_session` cookie (`worker/owner-session.ts`, HMAC with `AGENT_CERT_SECRET`, 30 days). The credentials API accepts it in place of an `at1` token; changes made with the cookie must carry this site's `Origin`. Opening `/` signed in shows that wallet's dashboard.
- Cards: `/api/credentials/cards` and `/api/credentials/cards/session` create AgentCard vault sessions (hosted page, passkey) and list display fields. The vault user ids for a wallet are kept in its KV record (`agentcardUsers`). AgentCard reports a session `linked` once the passkey user exists; the card is only stored when the session shows `card: true`, so callers wait for `cardSaved`.
- Buying: `agent buy` / `POST /api/credentials/buy` runs AgentCard's Purchase API (`/buy`) as the wallet's vault user (connection tokens exchanged from linked add-a-card sessions, sealed in `agentcardConnection`). The worker confirms carts itself: at or under the owner's auto-pay limit (`autoPayLimitCents`, default $25, dashboard Settings) right away; over it, it records an approval (`approvals`) and the owner signs in on `/approve` (worker-side OMS sign-in) to approve or decline. Agents never confirm. `agent checkout` / `POST /api/credentials/checkout` applies the same limit before an agent pays in its own browser (Kernel/Browserbase with AgentCard). `GET /api/credentials/approvals/<id>?wait=` long-polls the decision. App auto-approval (pay without AgentCard's passkey link) needs production credentials and `AGENTCARD_AUTO_APPROVAL=on`; sandbox confirms end in `sandbox_mode`.
- Paying once: approving a purchase (`/approve`) and Muse's `confirm_purchase` claim it first in a per-wallet Durable Object (`worker/wallet-lock.ts`, binding `WALLET_LOCK`, migration `v3`), because Workers KV has no atomic write. The first claim wins; later ones get the current status. It has no route: only the worker reaches it. Without the binding (tests, local) a claim in the KV record plus an in-worker guard stands in. The CLI calls the saved-details site at `POLYGON_AGENT_CREDENTIALS_URL` (default: the login page's site), so sign-in and saved details can run on different deployments.
- MCP: the worker serves a remote MCP server at `/mcp` (`worker/mcp.ts`, stateless JSON-RPC) behind `@cloudflare/workers-oauth-provider` (`/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*`; `OAUTH_KV` binding). `/authorize` hands off to the SPA's `/connect` page, where the owner signs in by email code or Google (skipped when already signed in on the site), then sees a consent screen (what the agent can do, with the auto-pay limit) and allows or denies (`/api/connect/decide`; deny returns `access_denied`). Settings lists connected agents (`/api/agents`, the provider's grants; owner session cookie only) with Disconnect (`revokeGrant`). the worker does that OMS sign-in itself (`worker/owner-signin.ts`, state sealed in KV for 10 minutes) because the OMS project only accepts browser calls from the production origin. Tools cover balances, the saved address and cards, and buying; moving funds stays in the CLI.
- MCP client profiles (`worker/profiles.ts`): each connection gets a profile when the owner allows it, from its OAuth client id via `MCP_CLIENT_PROFILES` (JSON, client id to profile; unlisted clients and older connections are `standard`), kept in the grant's `props`. A profile is a tool allowlist, checked on `tools/list` and `tools/call`, and whether purchases need the user's confirmation. `standard`: all tools, and `buy` pays at once under the auto-pay limit. `muse` (Muse takes no money movement and asks the user before every purchase): `buy` returns a quote (`quotes` in the wallet record, 15 minutes) and only `confirm_purchase` with the same `total_cents` pays it, at most once; over the auto-pay limit the owner still approves on `/approve`; no `authorize_checkout`. A platform's client is registered at `/oauth/register` with its redirect URIs, and the returned client id goes in `MCP_CLIENT_PROFILES`.
- Local MCP: `npx wrangler@4 dev --env staging --port 8787 --local-upstream localhost:8787` (secrets in the gitignored `.dev.vars.staging`).
- Worker secrets are GitHub environment secrets, uploaded by the deploy workflow with `wrangler deploy --secrets-file`: `AGENT_CERT_SECRET`, `CREDENTIALS_KEY`, `AGENTCARD_CLIENT_ID`, `AGENTCARD_CLIENT_SECRET`, `INDEXER_ACCESS_KEY` (from `VITE_INDEXER_ACCESS_KEY`). The KV namespace has no id in `wrangler.toml`; wrangler creates it on the first deploy.
