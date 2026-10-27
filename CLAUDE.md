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

Skills: one skill, Open Money Agent, in `skills/open-money-agent/`. `SKILL.md` is the index every agent reads
(kept under 12 KB): check the CLI is installed, run `wallet status` first, then route
the request to `references/<topic>.md`, loaded only for that task. Each reference opens with a
title and a `**When to use:**` line; only the index has frontmatter. `src/lib/skills.test.ts`
(CLI package) enforces this, and that every reference is linked from the index. The CLI bundles
the folder (`scripts/build.mjs`), `workspace init` installs it with its references, and
`skills show <topic>` prints a reference (old skill names map to topics). The agentconnect site
serves the index at `/skill.md` (the URL assistants are given), `/SKILL.md`, `/setup.md`, `/open-money-agent/SKILL.md` and every older skill URL, and
the references at `/references/` too (`vite.config.ts`). Also distributed via `npx skills add`
and the plugins, not via npm on its own.

Plugins: the repo is a plugin marketplace for Claude Code (`.claude-plugin/marketplace.json`),
Codex (`.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`) and Cursor
(`.cursor-plugin/marketplace.json`). Each points at `plugins/open-money-agent/`, whose `skills` and
`assets` are symlinks to the root folders, so a skill edit needs no plugin change. The manifests
carry no `version`, so installs update with each commit. Check with `claude plugin validate .`.
ChatGPT has its own package, `plugins/open-money-agent-chatgpt/`: the MCP server, which gives
ChatGPT only `get_wallet` (its `openai` profile), and no skills (ChatGPT plugins may not move funds). It has a `version`, bumped for each upload; how to
build and submit it is in `docs/CHATGPT_PLUGIN.md`.

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

## Site sign-in and MCP (agentconnect)

- Site sign-in: the dashboard's own sign-in (email code or Google) runs in the worker (`/api/session/*`, reusing `worker/owner-signin.ts`) and sets an HttpOnly `agentconnect_session` cookie (`worker/owner-session.ts`, HMAC with `AGENT_CERT_SECRET`, 30 days). Requests that change something with the cookie must carry this site's `Origin`. Opening `/` signed in shows that wallet's dashboard: the wallet of the method signed in with (OMS gives each sign-in method its own wallet).
- The CLI's dashboard links use `POLYGON_AGENT_CREDENTIALS_URL` (default: the login page's site), so sign-in and the dashboard can run on different deployments.
- Saved details (the shipping address, agent sign-in with `at1` tokens) and cards and buying (AgentCard vault, `agent buy`, approvals, the auto-pay limit, the per-wallet payment lock) are built on the `cards` branch, not on staging. Staging's wrangler migration `v4` deleted the `WalletLock` Durable Object class, so bringing it back takes a new migration tag.
- MCP: the worker serves a remote MCP server at `/mcp` (`worker/mcp.ts`, stateless JSON-RPC) behind `@cloudflare/workers-oauth-provider` (`/authorize`, `/oauth/token`, `/oauth/register`, `/.well-known/*`; `OAUTH_KV` binding). `/authorize` hands off to the SPA's `/connect` page, where the owner signs in by email code or Google (skipped when already signed in on the site), then sees a consent screen (what the agent can do) and allows or denies (`/api/connect/decide`; deny returns `access_denied`). Settings lists connected agents (`/api/agents`, the provider's grants; owner session cookie only) with Disconnect (`revokeGrant`, which also revokes the connection's key). the worker does that OMS sign-in itself (`worker/owner-signin.ts`, state sealed in KV for 10 minutes) because the OMS project only accepts browser calls from the production origin. Tools: `get_wallet` (address, balances, dashboard link) and, for profiles that move money, `get_allowance`, `send`, `swap_quote`, `swap` (swaps and bridges through Trails), `swap_status`, `pay_service` (x402), `earn_vaults`, `earn_deposit`, `earn_withdraw`, the `polymarket_*` tools and `get_action`. Only a connection with a key (`props.keyId`) sees anything but `get_wallet`.
- MCP money movement (`worker/money/`): a connection that moves money gets its own session key, like a CLI install's. On the consent screen the owner picks an allowance (USD over 1 to 30 days, default $1,000 over 30) and must sign in on the page, even when signed in on the site: the OMS session is kept (sealed) until they decide, then the worker plans the allowance (`plan.ts`, same rules and token table as the CLI's session mode; `tokens.test.ts` checks the tables match), registers the key, approves the plan for it on each chain as the owner, reads it back and keeps only what matches (`connect.ts`), and signs out. Each key lives in its own Durable Object (`agent-key.ts`, binding `AGENT_KEYS`, migration `v5`, id in the grant's `props.keyId` and `metadata.keyId`), sealed with `CREDENTIALS_KEY`, with its nonce, approved plan, transfer records and trades; it runs one request at a time. `engine.ts` is the CLI's transfer engine (records before sending, settles before the next, never resends) and `trade.ts` its Trails swap flow (deposit checked against the quote). Spending is ERC-20 transfers of covered tokens only, as in the CLI.
  - x402 (`x402.ts`): the connection's own x402 signer key (sealed in its Durable Object) signs an EIP-3009 authorization for the price the service asks, never over `max_usd`; the wallet funds it with one transfer for whatever it's short. Leftovers stay with the signer.
  - Earn (`earn.ts`): Morpho vaults Trails lists on Katana and Polygon. OMS session keys only transfer tokens, so a deposit is a Trails intent paid by the key whose destination call is the vault's `deposit` for the wallet (`QuoteParams.call`, checked against the quote; never from an agent's arguments). A withdrawal is a call from the wallet itself: it always answers with an approval link and runs from the owner's wallet (`owner-run.ts`).
  - Polymarket (`polymarket.ts`): one trading key and Deposit Wallet per agent wallet, as in the CLI's session mode, kept in the wallet's own object (the same `AgentKey` class, named `wallet:<address>`, `wstore_*` ops) so every connection trades the same account, one connection at a time (a 5-minute lease); funding is one USDC transfer to Polymarket's bridge, from the allowance. Region rules apply to the owner: their browser's country and subdivision when connecting (Cloudflare's `cf.country`/`regionCode`, kept in `props.ownerRegion`) against Polymarket's published blocked and close-only lists, and the worker's own geoblock check; the stricter wins.
- MCP approvals (`money/actions.ts`, SPA `/approve`, `/api/actions/<keyId>/<actionId>`): a request saved for the owner to approve, for 15 minutes. Spends from a profile with `ownerApproves` (ChatGPT) and every earn withdrawal answer `pending_approval` with a link; the owner, signed in on the site, approves or declines. A withdrawal runs from the owner's wallet, so approving it means signing in on the page (kept until they answer); the worker never keeps an owner sign-in beyond that, so a compromise can't reach more than each connection's allowance. `get_action` reports the outcome. A decided request never runs again.
- MCP client profiles (`worker/profiles.ts`): each connection gets a profile when the owner allows it, from its OAuth client id via `MCP_CLIENT_PROFILES` (JSON, client id to profile), else from its redirect URI (`chatgpt.com`, `chat.openai.com`: `openai`), else `standard`; kept in the grant's `props`. A profile is a tool allowlist, checked on `tools/list` and `tools/call`, whether connecting asks for an allowance, and whether each spend waits for the owner's approval. `standard`: every tool, spending within the allowance. `openai` (ChatGPT): every tool, and each spend (Polymarket included) waits for the owner's approval on the site; `propose_bundle` puts several spends (2 to 5) in one approval, run in order. Approving answers at once and the spend runs in the background (a Durable Object alarm); `get_action` waits up to 45 seconds for the answer and result, so the agent carries on by itself. `muse`: the same as `standard`. A platform's client is registered at `/oauth/register` with its redirect URIs, and the returned client id goes in `MCP_CLIENT_PROFILES`. Connections made before an allowance existed have no key; their money tools say to connect again.
- Local MCP: `npx wrangler@4 dev --env staging --port 8787 --local-upstream localhost:8787` (secrets in the gitignored `.dev.vars.staging`).
- Worker secrets are GitHub environment secrets, uploaded by the deploy workflow with `wrangler deploy --secrets-file`: `AGENT_CERT_SECRET` (session cookie HMAC), `CREDENTIALS_KEY` (seals sign-ins in progress and each MCP connection's key), `INDEXER_ACCESS_KEY` (from `VITE_INDEXER_ACCESS_KEY`), `TRAILS_API_KEY` (from `VITE_TRAILS_API_KEY`; prices, swaps and bridges for MCP connections). The `OAUTH_KV` namespace has no id in `wrangler.toml`; wrangler creates it on the first deploy.
