# @polygonlabs/agentconnect-ui

## 0.2.1

### Patch Changes

- a167de5: ChatGPT connections get the Polymarket tools too: funding the account and making or selling predictions. Polymarket is described as making predictions throughout. Like every spend from ChatGPT, each one waits for the owner's approval on the site. The ChatGPT plugin listing (1.2.0) describes the wallet as the owner's own with the Open Money Stack, has review cases for earn and Polymarket, and the guide covers testing the MCP server in ChatGPT's developer mode.
- f263670: Polymarket region refusals say only "Polymarket trading isn't supported from your current location." They no longer name a country or say whether the owner's location or the service's is the limit, and `polymarket_account` reports just `access` and `rulesAsOf` for the region.
- b5baa34: Polymarket refusals say whose location is the limit. When the owner's location allows trading but Polymarket won't take new predictions from where the service runs, the error and `polymarket_account` say so (`limitedBy: 'server'`) and tell the agent it isn't the owner's account, instead of "not available for this owner". A buy is checked against Polymarket's region rules before the owner is asked to approve it.

  A buy on an account that isn't set up or is short of cash names the deposit to make (the bid plus 1% for the bridge, at least $2) and what the agent wallet holds, so the agent can offer the deposit and the buy together. `polymarket_account` shows the wallet's USDC before the account exists.

  The owner's location is updated whenever they answer a request on this site, not only when they connect. Argentina is added to Polymarket's close-only countries.

- f1ffd7b: Earn deposits, Polymarket deposits and Polymarket predictions check the wallet before the owner is asked to approve them, like sends: a wallet that can't cover it gets an answer at once instead of an approval link that fails. Whenever the wallet is short, the agent is told to ask the user to add funds from their dashboard.

  Approving a spend answers at once: it runs in the background (a Durable Object alarm) and the approval page follows it to the result. The agent no longer needs another prompt: `get_action` waits up to about 45 seconds for the owner's answer and the result, and agents are told to call it right after showing the link and again while it's pending, so they carry on as soon as the owner approves, or tell the user if it failed.

  ChatGPT can put several spends in one approval (`propose_bundle`, 2 to 5 steps run in order, stopping at the first that fails), e.g. funding Polymarket and then making a prediction. Muse connections can move money: they ask for an allowance when connecting and spend within it, like any other client.

## 0.2.0

### Minor Changes

- bf5b39f: The MCP server covers the rest of the agent wallet: paid web services (`pay_service`, x402), earn vaults (`earn_vaults`, `earn_deposit`, `earn_withdraw`) and Polymarket (markets, account, deposit, buy, sell, cancel, redeem, withdraw). Earn deposits are paid from the allowance through Trails; withdrawals run from the owner's wallet, so the owner approves them after signing in. Every connection to a wallet shares one Polymarket account. ChatGPT gets the same tools except funding Polymarket and betting, and every spend from ChatGPT waits for the owner's approval on the site (`/approve`, `get_action`). Polymarket follows its region rules for where the owner is.
- e81bb48: The MCP server can move money. Connecting an agent now asks the owner for a spending limit (US dollars over up to 30 days), and the agent gets its own key for it, approved by the owner on each chain the way a CLI install's is. New tools: `get_allowance`, `send`, `swap_quote`, `swap` (swaps and bridges) and `swap_status`. ChatGPT connections are recognised by their redirect and stay read-only, as do Muse's. Disconnecting an agent revokes its key. The skill tells assistants that can't run commands what the MCP server can do.

### Patch Changes

- 6c0f8af: The site serves OpenAI's domain check token, and the ChatGPT listing carries its support link and review test cases.
- 8191bd3: Ready for ChatGPT: the MCP server is named Open Money Agent, `get_wallet` declares its output and that it only reads the owner's wallet, denying a connection names the issuer like every other response, and the site can serve OpenAI's domain check at `/.well-known/openai-apps-challenge`. The plugin package is `plugins/open-money-agent-chatgpt/`.
- 18744bc: The fund modal shows the agent wallet's short address with a copy button, for sending funds to it directly.
- 2551ac0: Connecting an MCP client works on both sites the worker serves: each request checks its own site's `/mcp` as the OAuth resource, so ChatGPT's sign-in no longer fails depending on which site was served first. A bad authorization request now goes back to the client as an OAuth error instead of failing. The skill points assistants that can't run commands to the MCP server.
- d564966: Unknown `/.well-known` paths answer 404 instead of the site's page, so OAuth clients probing for OpenID metadata move on to the metadata the MCP server does serve.

## 0.1.0

### Minor Changes

- 050c2e0: Connecting an agent now ends on a consent screen: after signing in (skipped if you're already signed in on the site), you see what the agent can do, including that it can't move your money, and choose Allow or Don't allow. Settings lists your connected agents, each with Disconnect.
- cf0a8a0: A remote MCP server for the agent wallet at `/mcp`, so agents that can't run the CLI can connect. The owner approves on a connect page with an email code or Google. Its tool, `get_wallet`, gives the address, holdings in dollars, and the dashboard link.
- c0b1809: Redesign the dashboard as a consumer wallet on the OMS design system: sidebar and phone tab bar, Overview with balance buckets, a 14-day money in and out chart and recent activity, plus Wallet, Markets (Polymarket positions via `?pm=`), Earn (Prime, Frontier, and Advanced: Morpho stablecoin vaults on Katana, assigned by size from the Trails Yield API), Activity, and Settings tabs. Opening the page without a wallet now shows a connect-your-agent screen with a spending limit picker.
- c1e442f: Sign in on the site itself. Opening agentconnect without a link from your agent now shows sign-in (email code or Google), then your dashboard, and you stay signed in for 30 days. The worker does the sign-in and sets an HttpOnly session cookie, so it works on every domain. Settings has a Sign out button.

### Patch Changes

- faf204d: After allowing a local agent (Claude Code, Codex, Cursor) on the connect page, the owner lands on their dashboard instead of the agent's "you can close this" page.
- 40e0fc3: Dashboard: ask-your-agent prompts on Overview and Wallet, alongside Markets and Earn. Earn tiers are picked so each riskier tier pays more than the one before it; one that doesn't is left out.
- eb13f18: MCP client profiles: each connected agent gets a profile from its OAuth client. Muse's profile shows only the tools Muse allows; every other agent works as before. Client registration (`/oauth/register`) is capped at 10 a minute per address.
- 0ae28a3: AgentPay is now Open Money Agent. The skill is `skills/open-money-agent/` and the plugin is `open-money-agent` in Claude Code, Codex and Cursor (existing `agentpay` plugin installs need a reinstall under the new name). `workspace init` and `update` install `open-money-agent` and remove the `agentpay` folder they wrote before; `skills show agentpay` still works. The site keeps serving `/agentpay/SKILL.md` and `/agentpay/references/`.

## 0.0.5

### Patch Changes

- 64c4104: One skill, AgentPay, the user's own agent for payments on the Open Money Stack (OMS). The six skill files are now `skills/agentpay/`: a short `SKILL.md` index (check the install, then `wallet status` first, then route the request) and a reference per use case under `references/`, loaded only when a task needs it. `workspace init` installs `agentpay` with its references and removes the `polygon-agent-wallet` and `polygon-oms-wallet` folders it wrote before. `skills show <topic>` prints a reference, and the old skill names still work there. The site serves the index at `/skill.md`, now the link assistants are given, and at `/SKILL.md`, `/setup.md` and every older skill URL, and the references at `/references/`.

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
