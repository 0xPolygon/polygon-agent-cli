# Change Log

## 0.15.2

### Patch Changes

- fc80908: - The product is now called Polygon Agent Wallet. A connected install appears to the wallet owner as "Polygon Agent Wallet (<install name>)", and `setup.md` uses the new name.
  - The Polymarket skill says what to do when the platform stops commands before `deposit --broadcast`'s 5-minute wait: allow 6 minutes, or use `--no-wait` and check `status` later.

## 0.15.1

### Patch Changes

- 749131b: Assistant skills: after the install, and whenever the wallet isn't connected, the assistant asks "Would you like to sign in now?" instead of stopping on a status report. `setup.md` works better on Hermes: the workspace follows `$HERMES_HOME`, `ROOT` is exported, the install steps allow up to 10 minutes, and watches note that Hermes cron jobs need the gateway running. The `npx skills add` fallback copies instead of symlinking. The repo is now a plugin marketplace for Claude Code, Codex and Cursor.

## 0.15.0

### Minor Changes

- 9794da1: Skills for personal assistants: `setup.md` (the one-time install guide: workspace install, Node if needed, the skill, connect by email code, funding) and the `polygon-oms-wallet` skill, which `workspace init` installs pointed at the wrapper. The `polygon-agent-cli` skill gains session mode, prices, watches, alerts and workspace installs; `polygon-discovery` gains `--max-usd`. The skills site also serves `/setup.md` and a skill index at `/.well-known/agent-skills/index.json`, and redeploys when skills change. `wallet status` reports a pending request before the first connect (so it's resumed, not resent); `watch check` returns the schedule to keep (or `null` once nothing needs checking); `workspace init` accepts `~/.polygon-agent` alongside a global install's state.
- 468145c: Buying a token amount, paying with other holdings, and assistant skill fixes from Muse QA:
  - `swap --to-amount <n>` buys at least that much of `--to` ("buy 10 POL"), using a Trails exact-output quote; more decimals than the token has are refused. The deposit is the quoted input, so the quote must guarantee the amount asked for, and it's never executed in one step: the user accepts it by its intent (`confirmation_required`). Estimates only rank candidates, including near-miss stablecoins and sufficiently funded holdings ahead of dust balances. Actual quotes decide affordability. A bounded search reports untried sources with ready-to-run preview commands instead of declaring insufficient funds.
  - Without `--from`, a buy in USD or by `--to-amount` falls back to another covered token the wallet holds (largest first, never the token bought) when stablecoin balances look too small or quotes fail. Such a quote is never executed in one step (`confirmation_required`). Watches' auto trades still pay only with stablecoins. A holding that can't be priced makes the answer unknown (`upstream_unavailable`), not `insufficient_balance`. In owner mode, WPOL or WETH can pay for native POL or ETH. Destination precision is validated on the selected chain, and malformed source amounts are rejected before funding discovery.
  - `wallet confirm` no longer prints `worstCase`.
  - The `polygon-oms-wallet` skill and `setup.md`: how to read buy and sell requests, the wallet address as a message of its own, a plainer connect message, and how to raise the limit with a new code.
  - Expected Trails quote failures are structured errors with reasons and preview commands. Query failures and high-price-impact refusals can try another source without relaxing limits; outages and invalid quotes stop immediately. Dollar buys, including automatic watches, may use another covered chain when no destination chain is specified. Incomplete watch searches remain armed.

- 909af36: Move Polymarket reads to the current APIs before Data API v1 retires on 2026-10-24.
  - `polymarket positions` reads Data API v2. Rows are snake_case (`current_size`, `avg_price`, `current_price`, `unrealized_pnl`, `redeemable`). New `--status` (`OPEN`, `REDEEMABLE`, `REDEEMABLE_LOST`, `MERGEABLE`, `CLOSED`), `--limit` and `--cursor` options, and the output includes `nextCursor`.
  - `polymarket markets` lists through Gamma's keyset endpoint and searches through `/public-search`. Paging uses `--cursor <nextCursor>`; `--offset` now fails with `code: offset_removed`.
  - `polymarket market` looks markets up by condition id directly, including closed ones, and reports `version`, `closed` and `acceptingOrders`.
  - Token ids come from `positionIds` for Polymarket V2 markets and `clobTokenIds` for V1 markets. `clob-buy` and `sell` refuse V2 markets (`code: unsupported_market_version`) and markets not accepting orders (`code: market_not_accepting_orders`), including on dry runs.
  - `polymarket approve` sets one batch covering the standard, neg-risk and Polymarket V2 exchanges. It no longer approves the deprecated Neg Risk Adapter, and `--neg-risk` is accepted but no longer needed. Wallets approved with an older version should run it once more.

- 7f1a93e: Polymarket trading through a CLI-managed Polymarket Deposit Wallet.
  - `polymarket setup` creates a trading key, deploys a Deposit Wallet and sets approvals through Polymarket's relayer, with no key import and no POL needed.
  - `deposit` and `withdraw` move money between the OMS wallet and Polymarket through Polymarket's bridge. Deposits are plain USDC transfers, so they work in session mode and count against the allowance.
  - New `status`, `event`, `book`, `history`, `buy`, `sell`, `cancel --all`, `redeem`, `activity` and `pnl`. Markets can be named by slug, and outcomes by name, including multi-outcome events.
  - `buy --max-price` and `sell --min-price` refuse a worse estimated fill before posting.
  - Region checks: blocked regions can't trade, and close-only regions can only sell, cancel, redeem and withdraw.
  - `clob-buy`, `proxy-wallet`, `approve` and `set-key` remain as hidden aliases for one release.
  - Polymarket commands run on Node 22 and 24. `@polymarket/client` declares Node 24 in `engines`, so `npm install` on Node 22 may print an `EBADENGINE` warning, which is safe to ignore.
  - The Polymarket trading key is backed up to the user's OMS account as one imported wallet labelled `polymarket-trading-key:<install name>`. Owner-mode `setup --broadcast` and every confirmed owner request in session mode do it, with no extra sign-in.
  - A wiped machine loses nothing. In owner mode, `status` shows `signer: "oms"` and every command signs through OMS. Signing through OMS is owner mode only; in session mode commands fail with `not_set_up` until the next owner request recovers. In session mode, the next owner request sweeps the old account's pUSD to the OMS wallet, archives the old records and backs up a new key. It never replaces the key while the old account still holds open positions, a deposit is still being credited, or a legacy proxy still holds funds. Reinstall with the same `--name` so the backup can be found.
  - `status` gains `backup`, `signer` and `otherTradingKeys`. New owner-mode `polymarket recover <address>` moves the pUSD of a trading key this install doesn't track.

- 1661c80: Polymarket: one trading key per user, found automatically on every sign-in.
  - New keys are backed up under one shared label, `polymarket-trading-key:agent`, so a user's account follows them to every install. Older per-install keys are still found. A lost key is never replaced any more, so keys stop piling up.
  - Every sign-in looks for the user's account. Signed in as the owner, it restores the account and signs through OMS. A session-mode install can't sign as that key, so it makes no second account: it returns `existingAccount` with a plain message ("You already have a Polymarket account with $4.20 and 2 open positions. Sign in once more to use it here.") and a command. `setup` and trading fail with the new `sign_in_required` code the same way, and `status` shows it.
  - `wallet login --owner` on a session-mode install now starts one more sign-in by the same method the install already uses (emailed code or login page). Once confirmed, the install keeps that sign-in for a week, its session keys are revoked, and it can use the account.
  - `polymarket buy` over the balance fails at once with the balance and shortfall, suggesting a smaller bid or a deposit of the shortfall (at least $2), or says a deposit is still being credited.

- c4eb0a4: Prices, watches and alerts: `price <token>` (USD price from Trails, canonical chain per symbol, stale after 5 minutes); `watch create|list|cancel|check|run` (alert or automatic trades at price levels, once per crossing, re-armed after a 2% move back); `alerts [--ack]`; `wallet status` reports watch alerts and whether checks are running. Session buys without `--to-chain` now pay from a chain where the token bought is covered.
- 46a8f79: Remove `polymarket import-key` (and the hidden `set-key` alias): it took a raw private key as an argument.
- 27fe324: Session mode: connect this install to an OMS wallet with an email code and a spending allowance, enforced on-chain by smart sessions. Owner mode is unchanged.
  - **Owner requests (email code, two steps).**
    - `wallet login --email <e> [--allowance] [--days] [--chains]` registers this install's session key, builds the plan and sends a code.
    - `wallet confirm --request <id> --code <code>` signs in, approves one session per chain, verifies the sessions and checks gas sponsorship through the session key, then always revokes the sign-in. Nothing owner-level is stored.
    - The same two steps run `wallet allowance set [--amount] [--add <token@chain>] [--chains]`, `wallet allowance renew [--days]` (a new session key), `wallet withdraw` and `wallet access [--revoke <id>]`.
  - **Allowance.**
    - Each covered token on each covered chain gets an on-chain limit worth the whole allowance, in a reviewed table of tokens (USDC, USDT, USDG, WETH, WBTC, cbBTC, WPOL/POL) on Polygon, Base, Ethereum, Arbitrum, Optimism, BNB Chain, Avalanche, Arbitrum Nova and Katana.
    - A local USD ledger caps the total across tokens.
  - **Spending.**
    - `runTx` routes session-mode wallets through `lib/session/transfer.ts`, which records each transfer before sending, reconciles uncertain ones, and never resends.
    - `send-token`, `swap` (from covered ERC-20s) and `x402-pay` work within the allowance.
    - Native coins return `native_not_supported`; other contract calls and Polymarket return `owner_required`.
  - **Status.** `wallet status` and `wallet allowance` report the sessions (limits, used, remaining, expiry), the USD total, holdings the allowance does or doesn't cover, pending requests, alerts and, in `wallet status`, the latest CLI version.
  - `wallet logout` revokes this install's session key.
  - **Errors.** New commands return `{ok: false, error, code, hint?, command?}`.

- 1acbcbd: Sign-in methods: `wallet login` now connects with an allowance and picks the sign-in itself, a browser page or an emailed code.
  - **Session mode by default.** Bare `wallet login` is session mode. The browser method returns `waiting` with a page `url` and a `--wait` next. The chat method returns `email_required` or `code_sent`. `wallet login --owner` is the old owner sign-in (`--local` and `--remote` only work with it).
  - **Waiting.** `wallet login --wait` and `wallet confirm --request <id> --wait` block up to about 90 seconds. `allowance set`, `renew`, `withdraw` and `access` use the same picker and accept `--email`.
  - **Picker.** `POLYGON_AGENT_SIGNIN=browser|email` forces a method. `workspace init --platform <muse|openclaw|hermes|claude-code|cursor|codex|other>` records the assistant platform.
  - **Errors.** New codes `email_required`, `browser_signin_failed`, `request_cancelled` and `request_in_progress`.
  - **Funding.** Outputs may carry `funding: { url, reason?, amountUsd? }` for an empty wallet, `insufficient_balance` and a Polymarket deposit shortfall. The login page shows what the sign-in approves and offers funding after connect.
  - **Polymarket.** Every owner sign-in backs up the Polymarket trading key, and the result shows it as `polymarket`.
  - **Wording.** User-facing text says "agent wallet" instead of "OMS wallet".

- 773403d: Trading and x402 in session mode.
  - `swap` is built on a shared, resumable trade core (`lib/trade/`). A dry run saves the quote; `swap --intent <id> --broadcast` executes exactly that quote, and `swap status --intent <id>` resumes or reports a trade. A deposit is never sent twice: an interrupted trade picks up from its saved state and, in session mode, from the transfer engine's records.
  - Every quote is checked before anything is sent: the deposit must be exactly a transfer of the quoted amount of the source token to the intent's deposit address, owned by and delivering to the wallet (`upstream_invalid_quote` otherwise).
  - `--from` is optional (a covered stablecoin with enough balance and allowance: USDC on Polygon first); `--amount` takes a number, `<n>%` or `all`; `--amount-usd` sells a USD amount at the current price. In session mode buys of ETH, POL or BTC deliver the chain's covered WETH, WPOL or WBTC/cbBTC, and uncovered tokens return `not_covered`.
  - Slippage is capped by `max_slippage` in config.json (default 1%); fees over 10% of the trade add a warning.
  - `x402-pay` gains `--max-usd` and `--yes`. Payments over `x402_max_per_call` ($1) need `--yes` (`confirmation_required`), and `x402_daily_max` ($10 over 24 hours) caps the total (`daily_limit_exceeded`), on both payment paths. A service that fails after payment is reported plainly with what was paid.
  - Session-mode installs get their own Builder access key (Trails quotes need one) and x402 signer after connecting, or on first use: the same zero-step provisioning as browser login.
  - New error codes: `quote_expired`, `upstream_invalid_quote`, `trade_failed`, `confirmation_required`, `x402_price_exceeds_max`, `daily_limit_exceeded`.

- b432963: Upgrade `@polygonlabs/oms-wallet` to 0.3.1 (pinned), `@0xtrails/api` and `0xtrails` to 0.18.6, `@x402/*` to 2.28, `viem` to 2.57 and `@0xsequence/network` to 2.3.47.
  - Gas-sponsored transactions no longer fail with "Unable to pay gas": oms-wallet 0.3 calls the fee selector with an empty list for them, which now continues with no fee. Paid fees return the SDK's selection, including its index.
  - `swap` follows the Trails 0.18 flow: no `commitIntent` (deprecated), the deposit must have a successful on-chain receipt before the quote's intent is executed, and transient `executeIntent` failures are retried. A dry run now only quotes; it no longer commits the intent. Confirmation or execution failures name the intent id and deposit hash for recovery.
  - The funding widget uses 0xtrails 0.18's `to.token` (was `to.currency`).
  - `slow-redact` is pinned to 0.3.1 (the last version with provenance), pulled in by 0xtrails through WalletConnect's logger.

- ac85de4: Workspace installs: run the CLI from inside an assistant's workspace folder, with its own state.
  - `POLYGON_AGENT_HOME` sets the state folder (default `~/.polygon-agent`). All state, including `config.json` and the token-directory cache, now lives under it.
  - `workspace init --root <dir> [--skills-dir <dir>] [--name <name>]` does the setup, and is safe to re-run. It refuses a root that already holds other files. It writes:
    - a wrapper at `<root>/bin/polygon-agent`, which runs the CLI with `POLYGON_AGENT_HOME=<root>/state` and makes Node's `fetch` honor `HTTPS_PROXY`
    - a `.gitignore` containing `*`
    - `state/install.json`
    - the `polygon-oms-wallet` assistant skill, once a release bundles it
  - `skills show <name>` and `skills install [name] --dir <dir>` print or write the skills now bundled in `dist/skills/`. When run through the wrapper, they render the wrapper's path into the skill. A `POLYGON_AGENT=` line is set to the single-quoted path, so nothing in it is expanded by the shell.
  - `update` installs the latest CLI beside the current one, swaps it in, and re-runs `workspace init` from the new version. A failed install leaves the current CLI in place; a failed refresh rolls back. Concurrent updates of one workspace are serialized by a lock (`state/update.lock`). Outside a workspace install, it prints the global npm command.

### Patch Changes

- 257220d: The allowance is described as a dollar amount and period only, with no chains or tokens.
- b3e81d0: Make `x402-pay` respect the persisted transaction mode and shared `--broadcast` / `--dry-run` safety flags.
- 21fbf2d: Fix Google sign-in for browser owner requests (missing redirect storage).
- 2b3f26a: `wallet login --owner` on a session-mode install now revokes the install's session keys the way `wallet logout` does: through each key itself, with the owner sign-in only as a fallback. OMS refused the owner-only revoke, so the switch failed (safely, changing nothing) with "OMS is unavailable (Unauthorized)".
- 710888a: Polymarket: `setup --broadcast` in owner mode now finds a backed-up trading key under another install name. With no key of its own, it restores the one backed-up key whose account holds pUSD or positions instead of making a new account over it, and asks for `--from <address>` when several do. `--new` keeps the old behavior. Owner sign-in no longer makes a key on a new install while other installs' keys exist, so setup can restore one.
- 4517306: Polymarket: when several older accounts hold money, a session-mode sign-in gives the plain message with totals ("You already have 2 Polymarket accounts with $4.50 in total. Sign in once more to use them here.") instead of a technical error. Signed in, the result has `chooseAccount`: the accounts, a plain question for the user, and the `setup --from` command to run once they pick.
- f22cfad: `polymarket withdraw` now refuses amounts under Polymarket's $2 bridge minimum (`below_bridge_minimum`) before anything is sent. Below it, the bridge never paid out: the pUSD sat at the bridge address while the CLI reported that USDC would arrive. Trading key recovery and old-key sweeps leave a balance under $2 in the old account (its key stays in OMS) instead of stranding it at the bridge.
- 8721bc6: The assistant skill is now `polygon-agent-wallet` (was `polygon-oms-wallet`). `workspace init`, `update` and `skills install` install it under the new name and remove the old copy, so the assistant doesn't load both. `skills show polygon-oms-wallet` still works, and agentconnect still serves `/polygon-oms-wallet/SKILL.md` for older setup guides.
- d7d0cdb: Security hardening from a review of this release:
  - Wallet names are validated before they become file paths: a name like `../..` could otherwise make `wallet logout` or `wallet remove` delete folders outside the CLI's state. Wallet files with names that no longer pass are skipped when listing.
  - Symbols of tokens outside the reviewed table are shown only when short and plain (never their contract's name), and marked `unverified`, so an airdropped token can't carry instructions into `balances`, `wallet status` or alerts.
  - A swap quoted and broadcast in one step is refused (`confirmation_required`, with the command to accept it) when fees or price impact take more than 10%.
  - x402: authorizations valid for more than 15 minutes aren't funded or signed, redirects aren't followed, and `@file` arguments can't read the CLI's state folders (compared by device and inode).
  - Saved trade deposits are re-checked before sending (amount, token and the deposit address checked at quote time), prices dated in the future count as stale, and allowance limits refuse implausible token prices.
  - `update` installs the exact version it checked, with install scripts off.
  - Ctrl-C during an owner sign-in removes the sign-in key; locks recover from a reused process id; broken key files no longer hang the CLI; the encryption key is created atomically; the state folder is kept owner-only; withdrawals to the zero address or the token contract are refused.
- 7b4b03f: Session-mode sign-in now defaults to an emailed code. The browser is used only for an interactive terminal or a local coding agent (claude-code, cursor, codex) with no headless signal, and container detection also covers Podman, Kubernetes, and cgroup markers. Every connect and `wallet status` now return `dashboard.url`, the wallet's agentconnect page, and the CLI no longer opens the funding page on its own after a connect (`agent fund` still does).
- 00f3df3: The wallet skill opens with how the assistant should come across (warm, matching the user's tone, useful opinions, no tool narration) and what it's for: getting the user set up, then making a payment, or funding the wallet for Polymarket or earning.
- cac16df: The wallet skill is the one installed entry point: it reaches the Polymarket, DeFi, x402 discovery and full CLI skills through `skills show <name>`, which prints the copy bundled with the installed CLI, instead of linking to them on the web.

## 0.14.0

### Minor Changes

- 64f4c91: Point the agent discovery service (x402 services catalog) at its new domain, `agent-discovery.polygon.org`, replacing the retired `agentic-services.polygon.technology`.

## 0.13.0

### Minor Changes

- 5377af6: Add a persisted transaction mode and flatten the ERC-8004 command group.
  - New `agent mode [auto|dry-run]`: `auto` makes write commands broadcast immediately; the default `dry-run` keeps the preview-first behavior. `--dry-run` on any write command forces a preview regardless of mode. `wallet login` asks once (interactive prompt on a TTY, `modePrompt` field in the JSON output otherwise).
  - BREAKING: the `agent agent *` group is removed. Use top-level `register`, `identity` (replaces `agent agent wallet` + `agent agent metadata`), `reputation`, `reviews`, `feedback`. The hidden legacy aliases (`register`, `agent-wallet`, `agent-metadata`, `reputation`, `give-feedback`, `read-feedback`) and their interactive handlers are also removed.
  - Fix: `reputation` and `reviews` no longer crash with "Cannot assign to read only property '0'" (frozen ethers Result passed back into a contract call), and `reputation` no longer fails to serialize a BigInt decimals field.

## 0.12.0

### Minor Changes

- Zero-setup onboarding: `agent wallet login` is now the entire setup.
  - **`agent` is the primary command.** The CLI ships as `agent` (with `polygon-agent` kept as a long-form alias), so onboarding is `agent wallet login`.
  - **Browser login.** `wallet login` opens a branded login page (agentconnect) where the user chooses Google or email; email one-time codes are entered on the page. It works whether the browser and the CLI are on the same machine or different ones, so there is no separate remote mode. `--local` keeps the previous loopback flow (raw Google URL plus localhost callback); `--remote` is a deprecated no-op.
  - **No keys to obtain.** The CLI ships a default OMS publishable key, and a successful login auto-provisions a Sequence Builder project and access key (the indexer and Trails quota) into `~/.polygon-agent/builder.json`. Provisioning is best-effort: a failure never fails the login and retries on the next `wallet login`. Point at your own project with `OMS_PUBLISHABLE_KEY` (renamed from `SEQUENCE_PUBLISHABLE_KEY`) or `setup --oms-publishable-key`.
  - **Post-login and funding land on the agentconnect dashboard** (wallet prefilled, same app). The `fund` command and the dashboard's Add funds button open the Trails funding widget directly. Relay and login-page URLs default to the production deployments and can be overridden with `POLYGON_AGENT_OIDC_RELAY` and `POLYGON_AGENT_LOGIN_UI`.

  Sessions and all downstream commands are unchanged, and existing sessions keep working until they expire.

- dd75624: Migrate the embedded wallet to `@polygonlabs/oms-wallet`, the renamed and updated successor to `@0xsequence/typescript-sdk`. Internally `OMSClient` becomes `OMSWallet`, with the same constructor shape and the same `.wallet` / `.indexer` sub-clients.

  **Node 22+ is now required** (was Node 20+). Update your runtime before upgrading.

  The Google leg of `wallet login` is re-architected onto the SDK's OMS relay: our own OAuth-capture endpoints are gone, and the OMS relay now handles the Google callback directly and returns the browser to the agentconnect login page to finish pairing with the CLI. This is an internal re-architecture with no user-facing behavior change beyond the Node floor: `wallet login` still opens the same login page, still lets you choose Google or email, and sessions still last about a week.

  Email login, transactions, and balances are unchanged.

### Patch Changes

- 54b37bd: Refresh the x402 discovery skill (polygon-discovery) to the current Agentic Services catalog, and fix x402 payment-option selection.

  Skill: replaces the retired x402 bazaar endpoints with the live services on agentic-services.polygon.technology — Exa, SearchApi, Firecrawl, NewsAPI, NVIDIA NIM Llama 3.3/3.2, OpenRouter, Browserbase, Resend, Allium (9 endpoints), AgentMail (6), and QuickNode RPC across 16 chains — each with exact routes/URLs and prices, plus a pointer to the live `/api/discover/routes` catalog. Updates the x402 example lists in the root and CLI skills.

  Fixes to `x402-pay`:
  - Payment-option selection: no longer blindly pays the first advertised option. When a provider offers multiple options across chains (e.g. QuickNode lists Base Sepolia first), the CLI now selects the cheapest plain-USDC transfer on the preferred chain (default Polygon 137, or `--chain`), so a call settles ~$0.001 on Polygon instead of on a testnet.
  - JSON body handling: the standard x402 flow now sets `Content-Type: application/json` when a `--body` is provided and no content-type was given, so proxied POST services (Exa, Firecrawl, NVIDIA NIM, Resend, Browserbase, OpenRouter) receive a parseable body instead of rejecting it.

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [0.11.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.4...@polygonlabs/agent-cli@0.11.0) (2026-06-09)

### Features

- **cli:** add `call` command for arbitrary contract calls ([af8225f](https://github.com/0xPolygon/polygon-agent-cli/commit/af8225f415c15471760e33dbe13688114c265dfb))

## [0.10.4](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.3...@polygonlabs/agent-cli@0.10.4) (2026-05-27)

**Note:** Version bump only for package @polygonlabs/agent-cli

## [0.10.3](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.2...@polygonlabs/agent-cli@0.10.3) (2026-04-30)

### Bug Fixes

- **wallet:** prevent 'Raw mode is not supported' error in non-TTY environments ([4e6a269](https://github.com/0xPolygon/polygon-agent-cli/commit/4e6a269d9d0d1e0db6567235b5068474d6393fec))

## [0.10.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.1...@polygonlabs/agent-cli@0.10.2) (2026-04-29)

### Bug Fixes

- auto-whitelist Aave V3 Pool, enforce 0.1 gas reserve on deposit ([d7db76b](https://github.com/0xPolygon/polygon-agent-cli/commit/d7db76b1cd202fbe14d45e18c3fc2b23883907a6))
- **deposit:** restore native balance check, reserve USDC only when POL < 0.1 ([f4be1a9](https://github.com/0xPolygon/polygon-agent-cli/commit/f4be1a9e562e55eeda67481fe8a0cd665cab1e9a))

## [0.10.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.10.0...@polygonlabs/agent-cli@0.10.1) (2026-04-29)

**Note:** Version bump only for package @polygonlabs/agent-cli

# [0.10.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.5...@polygonlabs/agent-cli@0.10.0) (2026-04-28)

### Features

- **polymarket:** migrate to CLOB V2 SDK, pUSD collateral, and V2 exchange contracts ([95ad532](https://github.com/0xPolygon/polygon-agent-cli/commit/95ad53231556da3e61741598f503cf6057af8e8c))

## [0.9.5](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.4...@polygonlabs/agent-cli@0.9.5) (2026-04-27)

### Bug Fixes

- **wallet:** add POL native ERC-20 to default session whitelist ([93280af](https://github.com/0xPolygon/polygon-agent-cli/commit/93280af01ead364ebe00b1ccae619b295310a5db))
- **wallet:** remove Katana vault contracts from --defi whitelist ([04728b7](https://github.com/0xPolygon/polygon-agent-cli/commit/04728b796b566323d65275211398ad11b59f4f88))
- **wallet:** remove POL 0x1010 from default whitelist — not needed ([5b5f039](https://github.com/0xPolygon/polygon-agent-cli/commit/5b5f0392cc2cdb657700d2f90bbdd667e39809cc))
- **wallet:** scope default session whitelist to USDC/USDC.e; add --defi flag ([f8c9256](https://github.com/0xPolygon/polygon-agent-cli/commit/f8c92566a26257554c585555a5ff6dd6fd9ee591))

## [0.9.4](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.3...@polygonlabs/agent-cli@0.9.4) (2026-04-27)

### Bug Fixes

- **deposit:** pre-flight balance checks, gas reserve, session guard, and actionable errors ([8011838](https://github.com/0xPolygon/polygon-agent-cli/commit/8011838f1ded843fc9666d0f3cb215e8cf871701))
- **deposit:** remove Polygon-only chain restriction, support all Trails chains ([9d26bfc](https://github.com/0xPolygon/polygon-agent-cli/commit/9d26bfcb42f8fd516c4d5298891acca07b71c80b))
- **fund:** point to wallet.polygon.technology instead of demo.trails.build ([9e2735d](https://github.com/0xPolygon/polygon-agent-cli/commit/9e2735d531277d178d7f6c308a5ac625d0e47526))

### Reverts

- **wallet:** remove session replacement guard ([8ab8150](https://github.com/0xPolygon/polygon-agent-cli/commit/8ab81501925b0bf9a75ea765b2e81d89399a0621))

## [0.9.3](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.2...@polygonlabs/agent-cli@0.9.3) (2026-04-22)

### Bug Fixes

- **polymarket:** remove hardcoded feeRateBps to let CLOB client resolve market fee rate ([c6b8232](https://github.com/0xPolygon/polygon-agent-cli/commit/c6b823279b5f32076104983c3fdd8e73934dade6))

## [0.9.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.1...@polygonlabs/agent-cli@0.9.2) (2026-04-22)

### Bug Fixes

- **deposit:** correct APY display inflated by 100x ([4d3f1d0](https://github.com/0xPolygon/polygon-agent-cli/commit/4d3f1d0ab2132e50a1ff304409e69c55d4fafaa2))

## [0.9.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.9.0...@polygonlabs/agent-cli@0.9.1) (2026-04-21)

### Bug Fixes

- **cli:** always use builder.json access key for Trails API ([be49e24](https://github.com/0xPolygon/polygon-agent-cli/commit/be49e24cb94d54b5a2b041ca6d89d8d3b502c15a))

# [0.9.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.8.0...@polygonlabs/agent-cli@0.9.0) (2026-04-21)

### Bug Fixes

- **deposit:** whitelist ERC-20 token contracts and fix session error messages ([1beb54b](https://github.com/0xPolygon/polygon-agent-cli/commit/1beb54b61012c4661b3aa9602bb172b3e2c3c7d6))
- smart wallet usdc transfer limits and permissions order ([83e7f2c](https://github.com/0xPolygon/polygon-agent-cli/commit/83e7f2cf281390fbb019d78008a55245ca03fd1d))

### Features

- auto-resolve aToken and Vault positions by asset and protocol in withdraw command ([599cb69](https://github.com/0xPolygon/polygon-agent-cli/commit/599cb69bef4fb638b17e4cf924edd356b8db07de))
- **cli:** add --chains comma list for balances ([0a4f50c](https://github.com/0xPolygon/polygon-agent-cli/commit/0a4f50c1f8c71b9cc4cf9fb15cd46b4c4181a4c1))
- **cli:** add withdraw for Aave aTokens and ERC-4626 vaults ([494ccbc](https://github.com/0xPolygon/polygon-agent-cli/commit/494ccbc3e65c0a2cf87ed22794431cfcc47e183d))
- **cli:** drop bundled skills and sync hook ([d9872eb](https://github.com/0xPolygon/polygon-agent-cli/commit/d9872ebc8c7d0422af4e871e8e84d04080962f5a))

# [0.8.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.2...@polygonlabs/agent-cli@0.8.0) (2026-04-16)

### Bug Fixes

- **skills:** fix Twitter/X x402 endpoint in polygon-discovery ([8f667f9](https://github.com/0xPolygon/polygon-agent-cli/commit/8f667f97f8b51c26d95e77de37c6b8877b5a759b))
- **skills:** rename to "Polygon Agent" and fix Twitter/X x402 endpoint ([7909791](https://github.com/0xPolygon/polygon-agent-cli/commit/7909791aa715a3ed5a6aecdf5a0d35d5cf17b9c0))
- **skills:** update install command to npm install -g @polygonlabs/agent-cli ([e0ac8cb](https://github.com/0xPolygon/polygon-agent-cli/commit/e0ac8cb34212f9b4b24b22ea1fa6c3416744cc1a))
- **skills:** update Twitter/X description to follower/following counts and tweet metrics ([7dcfb29](https://github.com/0xPolygon/polygon-agent-cli/commit/7dcfb29d4e5b8c8b5c7227835ce84118adca7b47))
- **skills:** use absolute URLs for sub-skill discovery ([12a8d14](https://github.com/0xPolygon/polygon-agent-cli/commit/12a8d145363bd4749b628e2b94d497e7fa12cba7))
- **wallet:** allow pasting 6-digit code in wallet create flow ([81c9e90](https://github.com/0xPolygon/polygon-agent-cli/commit/81c9e907a7804bc3c885cf52a47eebaf14506e45))

### Features

- **skill:** add prerequisites check to polygon-discovery skill ([d16d6fa](https://github.com/0xPolygon/polygon-agent-cli/commit/d16d6fa8f1eff21f2338550d4f0acc40fc7248a3))
- **skills:** add getEarnPools API reference to polygon-defi skill ([a175c26](https://github.com/0xPolygon/polygon-agent-cli/commit/a175c2670914ad618541ab3dc8d56fac374e03a3))
- **skills:** add getEarnPools API reference to polygon-defi skill ([411d831](https://github.com/0xPolygon/polygon-agent-cli/commit/411d831fe5c43881f1aaa3e07b20359a79e3c673))

## [0.7.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.1...@polygonlabs/agent-cli@0.7.2) (2026-04-14)

### Bug Fixes

- **ci:** add --access public to lerna publish for scoped packages ([c157790](https://github.com/0xPolygon/polygon-agent-cli/commit/c1577907f1363e5a173e6f49321c545395260fb9))
- **cli:** bundle agent-shared into CLI instead of publishing to npm ([1cc2d7b](https://github.com/0xPolygon/polygon-agent-cli/commit/1cc2d7b28b971f7b4b85d9473393c9fce92edd57))
- **publish:** declare access in publishConfig, remove --access flag from workflow ([e5d23b1](https://github.com/0xPolygon/polygon-agent-cli/commit/e5d23b1ed8c296808f37251cd25843774efd55ac))

## [0.7.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.7.0...@polygonlabs/agent-cli@0.7.1) (2026-04-14)

**Note:** Version bump only for package @polygonlabs/agent-cli

# [0.7.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.7.0) (2026-04-14)

### Bug Fixes

- add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
- address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
- **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
- **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
- **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
- **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
- **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
- **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
- **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
- **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
- **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))

### Features

- **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
- **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
- **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
- **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
- refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
- **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
- **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
- **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
- **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
- **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))

# [0.6.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.6.0) (2026-04-14)

### Bug Fixes

- add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
- address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
- **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
- **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
- **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
- **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
- **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
- **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
- **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
- **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
- **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))

### Features

- **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
- **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
- **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
- **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
- refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
- **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
- **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
- **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
- **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
- **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))

# [0.5.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.5.0) (2026-04-14)

### Bug Fixes

- add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
- address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
- **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
- **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
- **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
- **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
- **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
- **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
- **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
- **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
- **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))

### Features

- **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
- **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
- **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
- **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
- refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
- **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
- **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
- **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
- **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
- **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))

# [0.4.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.3.0...@polygonlabs/agent-cli@0.4.0) (2026-04-14)

### Bug Fixes

- add VITE_TRAILS_API_KEY to build env and fix session payload mapping ([560ff65](https://github.com/0xPolygon/polygon-agent-cli/commit/560ff65bde87435254c3591aa09ab2c82f99aaaf))
- address code review issues — persist cliSk, raise payload limit, validate inputs, cleanup ([f38d2f2](https://github.com/0xPolygon/polygon-agent-cli/commit/f38d2f2afc59122655e46274e201016c0f4240f2))
- **ci:** use GitHub environments for per-env secrets, add CF Access token support to relay client ([9a89472](https://github.com/0xPolygon/polygon-agent-cli/commit/9a89472bcd740f4e3711046aefe8825e42777676))
- **cli:** wire --timeout to waitForReady, document ephemeral key storage ([3c08268](https://github.com/0xPolygon/polygon-agent-cli/commit/3c082688c73404338512eb68335c53cbe3790bc9))
- **dapp-client:** parse guard string back to GuardConfig with jsonRevivers ([6a2addb](https://github.com/0xPolygon/polygon-agent-cli/commit/6a2addb83db085c5385cdb56f706529ba73bbba5))
- **skills:** quote SKILL.md description to fix YAML colon parse error ([79e1f65](https://github.com/0xPolygon/polygon-agent-cli/commit/79e1f6542f4faed33f8aa4b4db6aa79dc99902db))
- **skills:** update x402 service endpoints to native onrender.com paths ([a29c3da](https://github.com/0xPolygon/polygon-agent-cli/commit/a29c3da0d851e625670d7e820b24082f42d1c9de))
- **x402-pay:** align payment_details handler with x402 Bazaar integration guide ([c3a751e](https://github.com/0xPolygon/polygon-agent-cli/commit/c3a751e1689b6f1dfc3155b30e13de19ec4ca686))
- **x402-pay:** implement EIP-3009 facilitator path for Polygon payment_details ([42d4d05](https://github.com/0xPolygon/polygon-agent-cli/commit/42d4d05bebe059e7c0ab617f12e88f2411ee0e15))
- **x402-pay:** scope Bazaar payment_details handling to x402-api.onrender.com only ([06563b0](https://github.com/0xPolygon/polygon-agent-cli/commit/06563b03cf483f9c7787231689a3257dc64844b9))
- **x402-pay:** use per-network recipient from payment_details.networks ([abd8da0](https://github.com/0xPolygon/polygon-agent-cli/commit/abd8da0929ca930fa5bd15212b3e01ea72466388))

### Features

- **cli:** auto-whitelist Polygon & Katana DeFi vault contracts in sessions ([d78a093](https://github.com/0xPolygon/polygon-agent-cli/commit/d78a09385448f25e5411673794c68dd474583039))
- **cli:** ink UI redesign and DX improvements ([8ad6596](https://github.com/0xPolygon/polygon-agent-cli/commit/8ad6596448b75590d699c1bcf3fa332c73750b7f))
- **cli:** polygon purple brand color, bordered code input, dry-run banner, tx result, fund TTY UI ([4490e86](https://github.com/0xPolygon/polygon-agent-cli/commit/4490e86dbd56c089790ffa176f825b782bc325ee))
- **cli:** replace cloudflared tunnel with relay + 6-digit code handoff ([8dba6fb](https://github.com/0xPolygon/polygon-agent-cli/commit/8dba6fb7540adcad4e74dfef574557682ac096c5))
- refactor skills into sub-skill files by use-case ([d8e1f7b](https://github.com/0xPolygon/polygon-agent-cli/commit/d8e1f7b0203f39b4a631b9ac90629e2b801ced92))
- **skills:** add DeFi sub-skill with swap, bridge, deposit, and vault whitelist ([2da3222](https://github.com/0xPolygon/polygon-agent-cli/commit/2da3222506ba1dfa69f32dc0091817084818d586))
- **skills:** add x402 Bazaar services section with call instructions ([0f73484](https://github.com/0xPolygon/polygon-agent-cli/commit/0f7348467f97fe48018a8a5bb284d5edbfd10807))
- **skills:** add yield vault whitelist and fix x402 Bazaar methods to POST ([dc17591](https://github.com/0xPolygon/polygon-agent-cli/commit/dc17591217136d62a0d40ace8ea0a17c910a733e))
- **ui,skills:** replace code review use case with lead scoring ([73b9283](https://github.com/0xPolygon/polygon-agent-cli/commit/73b92835379f641c81ac5f4b5765449d19e91523))
- **x402-pay:** handle custom payment_details 402 format from x402-api.onrender.com ([310a1db](https://github.com/0xPolygon/polygon-agent-cli/commit/310a1db56801299530189781048abea55fbd02bb))

# [0.3.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.2...@polygonlabs/agent-cli@0.3.0) (2026-03-17)

### Bug Fixes

- add missing @polymarket/order-utils dependency ([54fe8a2](https://github.com/0xPolygon/polygon-agent-cli/commit/54fe8a2a80c0f40cbad6ad20073e0d51e1309885))
- bump sequence SDK to beta.17 for counterfactual wallet support ([879e06f](https://github.com/0xPolygon/polygon-agent-cli/commit/879e06fabe1813187a5932ac6adde1c6c78441db))
- resolve file system race condition in polymarket key storage ([bf12021](https://github.com/0xPolygon/polygon-agent-cli/commit/bf1202160d50987540268539e3b66150cb645ffd))

### Features

- **polymarket:** port polymarket feature to TypeScript ([1a67055](https://github.com/0xPolygon/polygon-agent-cli/commit/1a67055e4f02b04f4fbf16e076d500901dcc47f2))
- **polymarket:** port to TypeScript, fix factory routing, update docs ([48f8636](https://github.com/0xPolygon/polygon-agent-cli/commit/48f8636600a278d512be0c377969e24178325078))

## [0.2.2](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.1...@polygonlabs/agent-cli@0.2.2) (2026-03-05)

### Bug Fixes

- **agent:** handle empty clients list in reputation command ([4a95561](https://github.com/0xPolygon/polygon-agent-cli/commit/4a955616089b604e10d442461f944403e62a207e))

## [0.2.1](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.2.0...@polygonlabs/agent-cli@0.2.1) (2026-03-05)

### Bug Fixes

- **publish:** add repository field to package.json files ([b037364](https://github.com/0xPolygon/polygon-agent-cli/commit/b037364323343900a041e16e4b8f7ff92345d95e))

# [0.2.0](https://github.com/0xPolygon/polygon-agent-cli/compare/@polygonlabs/agent-cli@0.1.2...@polygonlabs/agent-cli@0.2.0) (2026-03-04)

### Bug Fixes

- **dapp-client:** use getAndClear methods instead of save(null) ([6331f98](https://github.com/0xPolygon/polygon-agent-cli/commit/6331f98f919b077ced2dbc87b66f51aeec8c73a7))
- **release:** reset version to 0.1.2 and drop --conventional-graduate ([73ad183](https://github.com/0xPolygon/polygon-agent-cli/commit/73ad18302ea6aa71d2a0860d3f82abd3f663c2cd))
- **swap:** poll waitIntentReceipt until done instead of single call ([e815bc6](https://github.com/0xPolygon/polygon-agent-cli/commit/e815bc69478e78223918b95dd256ae01e90373ff))
- **swap:** use correct property path for intent status in timeout error ([ab88ba8](https://github.com/0xPolygon/polygon-agent-cli/commit/ab88ba8dad8f07ce2236a538a9fd9ce1eb9a09d4))
- **wallet:** auto-whitelist ValueForwarder and Trails contracts at session creation ([adc302a](https://github.com/0xPolygon/polygon-agent-cli/commit/adc302a708a1713410c8d0a62f4f5e67836d401a))
- **wallet:** remove Trails deposit contracts from auto-whitelist ([aeb78ca](https://github.com/0xPolygon/polygon-agent-cli/commit/aeb78ca0aea84a64d11cb5e9db4d24220e734f05))

### Features

- add version to cli commands ([5aa2d75](https://github.com/0xPolygon/polygon-agent-cli/commit/5aa2d75fa0c306686aa390f27d70a0eec0231dc4))
- **cli:** convert polygon-agent-cli from JavaScript to TypeScript + yargs ([186044d](https://github.com/0xPolygon/polygon-agent-cli/commit/186044d1262a4cc059b2ce1f93b982ab58dbc0e7))
- **cli:** show help when command is called without required subcommand ([8b87c5e](https://github.com/0xPolygon/polygon-agent-cli/commit/8b87c5e51ce900475e24676fa48dd06eea58ca7a))
- **cli:** show subcommands in root --help descriptions ([9a7c390](https://github.com/0xPolygon/polygon-agent-cli/commit/9a7c390010f5bc9117cc57b73b8c6d8eb12eaeda))
