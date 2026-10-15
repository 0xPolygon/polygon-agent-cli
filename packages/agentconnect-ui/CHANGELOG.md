# @polygonlabs/agentconnect-ui

## 0.0.4

### Patch Changes

- 749131b: Assistant skills: after the install, and whenever the wallet isn't connected, the assistant asks "Would you like to sign in now?" instead of stopping on a status report. `setup.md` works better on Hermes: the workspace follows `$HERMES_HOME`, `ROOT` is exported, the install steps allow up to 10 minutes, and watches note that Hermes cron jobs need the gateway running. The `npx skills add` fallback copies instead of symlinking. The repo is now a plugin marketplace for Claude Code, Codex and Cursor.

## 0.0.3

### Patch Changes

- 769c626: Production deploys no longer fail on the long-deleted SessionRelay Durable Object: the production environment has an explicitly empty migrations list, as staging does.
- 9794da1: Skills for personal assistants: `setup.md` (the one-time install guide: workspace install, Node if needed, the skill, connect by email code, funding) and the `polygon-oms-wallet` skill, which `workspace init` installs pointed at the wrapper. The `polygon-agent-cli` skill gains session mode, prices, watches, alerts and workspace installs; `polygon-discovery` gains `--max-usd`. The skills site also serves `/setup.md` and a skill index at `/.well-known/agent-skills/index.json`, and redeploys when skills change. `wallet status` reports a pending request before the first connect (so it's resumed, not resent); `watch check` returns the schedule to keep (or `null` once nothing needs checking); `workspace init` accepts `~/.polygon-agent` alongside a global install's state.
- 355262e: Make the dashboard, funding, get-started, and login views responsive from 360px phones to desktop: stacked layouts, 44px tap targets, a wrapping wallet address with a copy button, and a funding modal that fits the viewport.
- de8609e: Login page subtitle is now simply "Login to your agent".
- 8721bc6: The assistant skill is now `polygon-agent-wallet` (was `polygon-oms-wallet`). `workspace init`, `update` and `skills install` install it under the new name and remove the old copy, so the assistant doesn't load both. `skills show polygon-oms-wallet` still works, and agentconnect still serves `/polygon-oms-wallet/SKILL.md` for older setup guides.
- 1acbcbd: Sign-in methods: `wallet login` now connects with an allowance and picks the sign-in itself, a browser page or an emailed code.
  - **Session mode by default.** Bare `wallet login` is session mode. The browser method returns `waiting` with a page `url` and a `--wait` next. The chat method returns `email_required` or `code_sent`. `wallet login --owner` is the old owner sign-in (`--local` and `--remote` only work with it).
  - **Waiting.** `wallet login --wait` and `wallet confirm --request <id> --wait` block up to about 90 seconds. `allowance set`, `renew`, `withdraw` and `access` use the same picker and accept `--email`.
  - **Picker.** `POLYGON_AGENT_SIGNIN=browser|email` forces a method. `workspace init --platform <muse|openclaw|hermes|claude-code|cursor|codex|other>` records the assistant platform.
  - **Errors.** New codes `email_required`, `browser_signin_failed`, `request_cancelled` and `request_in_progress`.
  - **Funding.** Outputs may carry `funding: { url, reason?, amountUsd? }` for an empty wallet, `insufficient_balance` and a Polymarket deposit shortfall. The login page shows what the sign-in approves and offers funding after connect.
  - **Polymarket.** Every owner sign-in backs up the Polymarket trading key, and the result shows it as `polymarket`.
  - **Wording.** User-facing text says "agent wallet" instead of "OMS wallet".

- b432963: Upgrade `@polygonlabs/oms-wallet` to 0.3.1 (pinned), `@0xtrails/api` and `0xtrails` to 0.18.6, `@x402/*` to 2.28, `viem` to 2.57 and `@0xsequence/network` to 2.3.47.
  - Gas-sponsored transactions no longer fail with "Unable to pay gas": oms-wallet 0.3 calls the fee selector with an empty list for them, which now continues with no fee. Paid fees return the SDK's selection, including its index.
  - `swap` follows the Trails 0.18 flow: no `commitIntent` (deprecated), the deposit must have a successful on-chain receipt before the quote's intent is executed, and transient `executeIntent` failures are retried. A dry run now only quotes; it no longer commits the intent. Confirmation or execution failures name the intent id and deposit hash for recovery.
  - The funding widget uses 0xtrails 0.18's `to.token` (was `to.currency`).
  - `slow-redact` is pinned to 0.3.1 (the last version with provenance), pulled in by 0xtrails through WalletConnect's logger.

## 0.0.2

### Patch Changes

- 64f4c91: Point the agent discovery service (x402 services catalog) at its new domain, `agent-discovery.polygon.org`, replacing the retired `agentic-services.polygon.technology`.

## 0.0.1

### Patch Changes

- 8be6b13: Show a get-started screen when the dashboard is opened without a wallet deep link. Instead of "Open this page from the polygon-agent CLI", it now displays the skill install command (`npx skills add https://github.com/0xPolygon/polygon-agent-cli`) and the starter prompt "set up a Polygon Agent for me", each with a copy button.

  Also serve the agent skills from this deployment: the build now copies the repo `skills/` tree into `dist/`, so the Cloudflare worker serves `SKILL.md`, `polygon-agent-cli/SKILL.md`, `polygon-defi/SKILL.md`, `polygon-discovery/SKILL.md`, and `polygon-polymarket/SKILL.md` at `agentconnect.polygon.technology` (previously served only by the retired connector-ui). The dashboard's main skill link now points at the canonical `polygon-agent-cli/SKILL.md`.

- c43a308: Serve the canonical skill at the legacy root URL. The build now aliases `polygon-agent-cli/SKILL.md` to `/SKILL.md` in the deployed assets, so `https://agentconnect.polygon.technology/SKILL.md` returns the skill markdown (200) instead of falling back to the SPA `index.html`. Deploy-only copy; the repo `skills/` tree is unchanged, so `npx skills add` still lists one canonical skill.
