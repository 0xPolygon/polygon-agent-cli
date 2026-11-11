# AGENTS.md

Instructions for agents working in this repository. `CLAUDE.md` imports this file, so every agent
reads one source. This file points at where things are defined; it does not copy them, because
copies drift. Read the code or config it names for specifics.

## What this repo is

A pnpm workspace for Polygon's agent tooling: a CLI that lets AI agents hold and use an on-chain
wallet, plus the hosted pieces that wallet sign-in and the remote connector need.

- `packages/polygon-agent-cli/` — the published CLI. Bin-only; shipped as an esbuild bundle
  (`scripts/build.mjs`). ABI JSON in `contracts/` ships with it via `files` in its `package.json`.
- `packages/agentconnect-ui/` — the agentconnect site (a React SPA) and its Cloudflare Worker
  (`worker/`), which also serves the remote MCP connector. Private, deployed.
- `packages/oidc-relay/` — a small Cloudflare Worker that pairs the CLI with the browser login
  page during sign-in. It carries pairing state only and authenticates no one. Private, deployed.

Each package's README (where present) is the entry point for that package.

## Skills and plugins

- One skill, Open Money Agent, in `skills/open-money-agent/`. `SKILL.md` is the index every agent
  reads; `references/<topic>.md` are loaded only for the task at hand. This split keeps the
  always-loaded part small. The format rules (size cap, headings, every reference linked from the
  index) are enforced by `packages/polygon-agent-cli/src/lib/skills.test.ts` — read it before
  restructuring the skill.
- `skills/` lives outside every package because two artefacts consume it: the CLI bundles it at
  build time and the agentconnect site serves it. Neither changes for users until released, so a
  `skills/` change needs a changeset for both packages (`.github/workflows/skills-changeset-check.yml`
  enforces it). Which URLs serve it is defined in `packages/agentconnect-ui/vite.config.ts`.
- The repo is also a plugin marketplace for Claude Code, Codex and Cursor (manifests in
  `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.cursor-plugin/`), all pointing at
  `plugins/open-money-agent/`, whose `skills` and `assets` are symlinks to the root folders so a
  skill edit needs no plugin change. The manifests carry no `version`, so installs track commits.
  Validate with `claude plugin validate .`.
- ChatGPT is separate: `plugins/open-money-agent-chatgpt/` is just the MCP connector config and has
  no skills. Unlike the others it is versioned and uploaded by hand; see `docs/CHATGPT_PLUGIN.md`.

## Development

- Node version: `.nvmrc` (development needs 24+; the published CLI supports an older floor, set by
  `engines` in the CLI's `package.json`, so don't use newer-only APIs in CLI code).
- pnpm version: `packageManager` in the root `package.json`. Use that exact version; a different one
  rewrites the lockfile.
- Scripts live in each `package.json`; most root ones fan out with `pnpm -r`.
- The CLI is yargs with the `CommandModule` builder/handler pattern. Commands are in
  `packages/polygon-agent-cli/src/commands/`, shared code in `src/lib/`, and ambient declarations
  for untyped dependencies in `src/types.d.ts`.
- Every write from the agent wallet goes through the one primitive in `src/lib/tx-dispatch.ts`.
  Add new spend paths there rather than calling the wallet client directly. Owner requests
  (`src/lib/owner/`) are the exception: they run as the owner, after the owner signs in.
- `wrangler` is a devDependency of `packages/agentconnect-ui` and `packages/oidc-relay`. Their
  deploys run `pnpm exec wrangler` after a frozen install, so the lockfile decides what runs and
  the supply-chain settings in `pnpm-workspace.yaml` cover it. Change the version in the package
  and the lockfile, not in a script. The relay's `deploy*` and `dev` package scripts still fetch
  wrangler 3 with `npx`.

## Testing

Vitest, per package. Tiers, layout and conventions are in `TESTING.md`.

## Wallet and sign-in model

- Wallets use the OMS V3 embedded-wallet model. The CLI signs in through the agentconnect login
  page or an emailed code and keeps the credential on disk. The sign-in flow is in
  `packages/polygon-agent-cli/src/commands/wallet.ts` and `src/lib/browser-login.ts`.
- The default is a session-mode connection: the owner signs in once to approve a limited allowance
  for the install's own key, then the owner sign-in is revoked, so a stolen install can spend only
  what that allowance covers. A full owner session is the exception and is opt-in.
- Each sign-in method has its own wallet: the wallet provider gives a Google sign-in and an email
  sign-in different wallets, even for the same person, and the dashboard shows the wallet of the
  method used. Don't assume one owner means one wallet.
- The CLI needs no setup step: it ships a default publishable key and provisions a project and
  access key on first login. Overrides exist for developers on their own project; the flags and
  environment variables are defined in `src/commands/` and `src/lib/config.ts`.

## The agentconnect Worker

Read `packages/agentconnect-ui/worker/index.ts` first; it routes everything.

- **Why the Worker signs in itself.** The dashboard's and the MCP connector's owner sign-in
  (`worker/owner-signin.ts`, cookie in `worker/owner-session.ts`) runs server-side because the OMS
  project only accepts browser calls from the production origin. In-flight sign-ins are sealed in
  KV for ten minutes only.
- **MCP connector** (`worker/mcp.ts`): stateless JSON-RPC behind the Cloudflare OAuth provider. The
  consent flow is handled by the SPA's connect page. A connection without a key can only read.
- **Client profiles** (`worker/profiles.ts`) define each client's tool allow-list, whether
  connecting asks for an allowance, and whether its spends wait for the owner's approval. A client
  is matched to a profile by `profileForClient` there (configured client ids first, then redirect
  URIs); give a client different rules through a profile, not by special-casing tools.
- **Why a money-moving connection gets its own key in its own Durable Object**
  (`worker/money/agent-key.ts`): the blast radius of any one connection is its own allowance, and
  the object serialises requests so a nonce or transfer record can't race. Allowance planning
  (`plan.ts`) deliberately mirrors the CLI's session mode and `tokens.test.ts` guards that the
  token tables match. The transfer engine (`engine.ts`) records before it sends and never resends,
  so a retry cannot double-spend.
- **Connecting keeps only what it can verify** (`worker/money/connect.ts`): after the owner approves
  an allowance for the connection's key on each chain, the Worker reads the approval back through
  the key and keeps only what matches the plan; anything else is revoked while the owner is still
  signed in. The CLI's session login follows the same steps.
- **Why a withdrawal always needs the owner** (`earn.ts`, `owner-run.ts`): session keys can only
  transfer tokens, so a withdrawal runs from the owner's own wallet and cannot be covered by an
  allowance. Approvals (`money/actions.ts`) expire, run once, and the Worker never keeps an owner
  sign-in past the owner's answer.
- **Polymarket access: the stricter rule wins** (`worker/money/polymarket.ts`): the owner's
  location recorded when connecting and Polymarket's own availability check are both evaluated, and
  the more restrictive result applies. An unknown location can only close positions.
- **Fixed destinations.** Deposit calls and funding targets are set by the Worker (from the code,
  the quote, or the service being paid), never from agent-supplied arguments (`earn.ts`,
  `trade.ts`, `polymarket.ts`).
- Worker config is typed bindings (`Env` in `worker/index.ts`); bindings are declared
  in `wrangler.toml`. Secrets are GitHub environment secrets uploaded
  with each deploy; see the deploy workflows in `.github/workflows/`. Vite's dev server does not run
  the Worker; run it locally with
  `pnpm exec wrangler dev --env staging --port 8787 --local-upstream localhost:8787` (from
  `packages/agentconnect-ui`), which reads
  secrets from the gitignored `.dev.vars.staging` (never committed).

## Releases and deploys

Changesets drive versioning and publishing; the process is in `docs/RELEASING.md`. Production
deploys of both Workers come from release tags, not from merges to `main`.

## Repo-specific adaptations of the team standards

"Team standards" means the maintainers' internal engineering standards, which are not published
with this repo; nothing here asks you to go and find them. These are the agreed departures from
them for this repo. A standard not listed here applies as written.

- **Service logging (CLI)** → non-interactive output goes only through the JSON output helpers in
  `packages/polygon-agent-cli/src/lib/errors.ts`; when run in a terminal the CLI draws its
  interactive views instead (`src/ui/`). Both are the contract, and the CLI does not use a service
  logger. New code avoids bare `console.*` outside those two paths. *Why:* the JSON output is the
  API the calling agent parses; structured service logs would corrupt it.
- **Service logging and HTTP middleware (Workers)** → no Node service logger or Express middleware;
  new Worker code logs structured JSON through a small helper over `console`. *Why:* the Workers
  runtime has neither Node streams nor an Express request cycle.
- **Error type (CLI)** → the CLI keeps its own `CliError` with stable `code` values at the user
  boundary. *Why:* callers branch on the code; a cause chain is not part of the contract.
- **Environment validation (Workers)** → no env-validation library; the typed bindings interface
  (`Env`) is the schema, and new code checks the bindings it needs once rather than at each use.
  *Why:* Worker config arrives as bindings per request, not `process.env`.
- **`NODE_ENV` and dotenv conventions** → not applicable. *Why:* there is no deployed Node
  service, only a CLI and two Workers.
- **Container, cluster, health-endpoint and cloud secret-manager rules** → not applicable. Secrets
  are GitHub environment secrets uploaded with the Worker deploy. *Why:* nothing here runs in a
  container or cluster.
- **No `tsx`** → `tsx` is used only by dev-time scripts (the CLI's `dev` script and the root
  runner script); it never reaches the shipped bundle. *Why:* the CLI's sources include JSX, which
  Node's native type stripping does not handle.
- **Library build scripts and `exports` conventions** → not used by the CLI. *Why:* it is a
  bin-only package bundled by esbuild with no importable API.
- **Named exports only** → the Workers' module entry (`export default { fetch }`) is
  framework-imposed.
- **Test tiers** → defined in `TESTING.md`, which owns them.
- **RPC client lifetime rules** → not applicable to the short-lived CLI process. They do apply to
  the Worker's request paths.
- **tsconfig layout for `agentconnect-ui`** → the SPA and the Worker need different `lib`/`types`
  sets, so each has its own config under the package's hub `tsconfig.json`.
- **Test assertion style** → the team's Chai-chain style rule is not applied here; tests use
  Vitest's standard matchers.
- **Dependency-update automation** → none is configured.
- **Licence** → MIT.
