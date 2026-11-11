# Coverage ledger

One row per command, tool, route or lifecycle, recording what the tests prove today. It exists so gaps are visible; a row is never upgraded to look better. Update the row in the same pull request that adds or removes a test (see [TESTING.md](../TESTING.md)).

## Legend

**Verdicts**

| Verdict | Meaning |
|---|---|
| `unit` | In-process tests with real assertions on values or state. External services are faked; "Not asserted" says what. |
| `weak` | An existing test that mocks so much it asserts little; the reason is in the row. It is not counted as coverage. |
| `GAP` | No meaningful test. `GAP: needs a testnet/sandbox the providers do not offer today` marks behaviour that needs a hosted service; any other gap states its reason. |
| `A` | Tier used by the ledger: the built CLI run as a subprocess, no network. |
| `A+` | Tier used by the ledger: the built CLI run as a subprocess against a local fake server. |
| `C` | Tier used by the ledger: tests in a Workers runtime with a real Durable Object or KV. |

No row uses `A`, `A+` or `C` today.

**Columns:** Surface | Command / op | Moves money | Verdict | Where (repo-relative test files) | Asserted | Not asserted, and why.

## CLI: setup and settings

Commands declared in `packages/polygon-agent-cli/src/commands/`.

**Totals (7 rows):** unit 5, GAP 2

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `setup` | no | GAP: no test yet | `packages/polygon-agent-cli/src/lib/builder-provision.test.ts`<br>`packages/polygon-agent-cli/src/lib/oms-config.test.ts` | Library level only: builder config resolution order and merging, provisioning lock. | The command itself: no test runs it against a stand-in for the Builder API. |
| CLI | `mode` | no | unit | `packages/polygon-agent-cli/src/lib/mode.test.ts` | Mode persistence in `config.json` (default, round trip, unrelated keys kept, invalid value) and `resolveBroadcast` flag precedence. | The `mode` command handler and its output. |
| CLI | `price` | no | GAP: needs a testnet/sandbox the providers do not offer today | `packages/polygon-agent-cli/src/lib/prices.test.ts`<br>`packages/polygon-agent-cli/src/lib/price-target.test.ts` | Library level only: price freshness and staleness rules, target parsing. | The command: prices come from a hosted price service. |
| CLI | `workspace init` | no | unit | `packages/polygon-agent-cli/src/lib/workspace.test.ts`<br>`packages/polygon-agent-cli/src/commands/workspace.test.ts` | Real-filesystem init: wrapper, state folder, `.gitignore`, `install.json`, idempotence, refusal of a root holding other files or a file, `--platform` recorded and kept. | Running the built binary. |
| CLI | `skills show` | no | unit | `packages/polygon-agent-cli/src/lib/workspace.test.ts` | Showing a reference by topic or by a legacy skill name; names that escape the skills folder are rejected. | The command handler output stream and exit code. |
| CLI | `skills install` | no | unit | `packages/polygon-agent-cli/src/lib/workspace.test.ts`<br>`packages/polygon-agent-cli/src/commands/workspace.test.ts`<br>`packages/polygon-agent-cli/src/lib/skills.test.ts` | Skill rendered for the wrapper, references replaced, legacy skills handled, index and reference format. | Running the built binary. |
| CLI | `update` | no | unit | `packages/polygon-agent-cli/src/commands/workspace.test.ts`<br>`packages/polygon-agent-cli/src/lib/version.test.ts` | Outside a workspace nothing installs; up-to-date no-op; swap-in and re-init; rollback on failed install or init; concurrent updates leave one working CLI. `npm` is replaced by a stub. | A real npm install and a real registry. |

## CLI: wallet

Commands declared in `commands/wallet.ts` and `commands/wallet-session.ts`. The tests run against an in-memory stand-in for the wallet SDK.

**Totals (14 rows):** unit 10, GAP 4

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `wallet login` (session) | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Step 1 plan and request, step 2 approve per chain, verify, save and revoke the sign-in; resume; wrong code; expiry; refusal of a second connect; browser waiter start and cancel; request files encrypted and owner-only. | Any hosted sign-in service; the stand-in wallet SDK replaces it. |
| CLI | `wallet login --wait` | no | GAP: no test yet | — | — | No test calls `login --wait`; the neighbouring `wallet confirm --wait` is covered on its own row. |
| CLI | `wallet login --owner` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-login.test.ts`<br>`packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Account selection and `--force`, already-signed-in short-circuit, option validation, key backup step and dashboard links, keeping a sign-in on a connected install. | The hosted sign-in page; the localhost callback flow (`--local`). |
| CLI | `wallet logout` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Session key revoked then local state removed; kept when the wallet service is unavailable so logout can be retried; waiters stopped and their files removed. | Owner-mode sign-out against a real service. |
| CLI | `wallet list` | no | GAP: no test yet | — | — | No test file covers the handler. |
| CLI | `wallet address` | no | GAP: no test yet | — | — | No test file covers the handler. |
| CLI | `wallet remove` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Refuses to remove a session wallet. | Removing an owner-mode wallet. |
| CLI | `wallet confirm` | indirect | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts`<br>`packages/polygon-agent-cli/src/lib/owner/requests.test.ts`<br>`packages/polygon-agent-cli/src/lib/owner/waiter.test.ts` | Code entry, `--wait` results (waiting, finished once, failed toward the emailed code), owner-request safety (key deleted on accept, newer request never deleted, different wallet refused). | Hosted owner sign-in; the stand-in wallet SDK replaces it. |
| CLI | `wallet status` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts`<br>`packages/polygon-agent-cli/src/lib/session/status.test.ts` | Dashboard and fund links, pending browser request, Polymarket account shown without secrets, alert keys, token labels, holdings. | Balance and allowance reads from the real services. |
| CLI | `wallet allowance` | no | GAP: no test yet | — | — | Only `allowance set` and `allowance renew` are exercised; the bare report has no test. |
| CLI | `wallet allowance set` | authorises spend | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Re-approves existing sessions by id and creates new chains; a change with nothing approved changes nothing. | Hosted approval. |
| CLI | `wallet allowance renew` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Sessions move to a new key, the old one is revoked and retried; interrupted renewal is finished by the next command. | Hosted revocation. |
| CLI | `wallet withdraw` | yes | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts`<br>`packages/polygon-agent-cli/src/lib/owner/actions.test.ts` | Refuses the zero address and the token contract before sending a code; sends exactly the transfer shown in step 1, as the owner. | A real transfer; the stand-in wallet SDK replaces the owner wallet. |
| CLI | `wallet access` | no | unit | `packages/polygon-agent-cli/src/commands/wallet-session.test.ts` | Lists sessions with chains, limits and usage; marks a session whose details cannot be read. | Revoking a key (`--revoke`) against a real service. |

## CLI: money and chain

Commands declared in `commands/operations.ts`.

**Totals (10 rows):** unit 2, weak 1, GAP 7

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `balances` | no | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Balances come from a hosted indexer. |
| CLI | `fund` | no | GAP: needs a testnet/sandbox the providers do not offer today | `packages/polygon-agent-cli/src/lib/funding.test.ts` | Library level only: funding and dashboard URL construction. | The command: needs a hosted indexer. |
| CLI | `send` | yes | GAP: no test yet | — | — | No test calls `send`; it dispatches to the two rows below. |
| CLI | `send-native` | yes | unit | `packages/polygon-agent-cli/src/commands/operations-errors.test.ts` | Session mode fails with `native_not_supported`. | Any owner-mode send; broadcasting needs a hosted relayer. |
| CLI | `send-token` | yes | GAP: needs a testnet/sandbox the providers do not offer today | `packages/polygon-agent-cli/src/lib/session/transfer.test.ts` | Library level only: the session transfer engine (records before sending, never resends, caps). | The command and the transaction primitive: broadcasting needs a hosted relayer. |
| CLI | `call` | yes | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Broadcasting needs a hosted relayer. |
| CLI | `swap` | yes | weak | `packages/polygon-agent-cli/src/commands/operations.test.ts`<br>`packages/polygon-agent-cli/src/commands/operations-swap-holding.test.ts`<br>`packages/polygon-agent-cli/src/lib/trade/trade.test.ts`<br>`packages/polygon-agent-cli/src/lib/trade/validate.test.ts` | Command tests assert mock call counts: quote, execute, receipt and transaction primitive are all mocked. The trade library tests assert quote validation and state with storage and sessions mocked. | Any real quote or execution; needs a hosted swap service. |
| CLI | `deposit` | yes | GAP: needs a testnet/sandbox the providers do not offer today | — | — | No test names deposit, Aave or Morpho; needs a hosted earn service and a relayer. |
| CLI | `withdraw` | yes | GAP: needs a testnet/sandbox the providers do not offer today | — | — | No test names withdraw, Aave or Morpho; needs a hosted earn service and a relayer. |
| CLI | `x402-pay` | yes | unit | `packages/polygon-agent-cli/src/commands/operations-x402.test.ts`<br>`packages/polygon-agent-cli/src/commands/operations-x402-mode.test.ts`<br>`packages/polygon-agent-cli/src/lib/x402-guard.test.ts`<br>`packages/polygon-agent-cli/src/lib/x402-redirect.test.ts`<br>`packages/polygon-agent-cli/src/lib/x402-funding-wait.test.ts` | Payment ledger outcomes (settled, uncertain and unsettled all stay counted), authorization recorded before sending, 15-minute cap, funding lock, offer ranking, redirect refusal, dry run funds and pays nothing. Signing, funding and the paid request are stubbed. | A real service, signature or settlement. |

## CLI: watch

Commands declared in `commands/watch.ts`.

**Totals (6 rows):** unit 4, GAP 2

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `watch create` | no | unit | `packages/polygon-agent-cli/src/commands/watch.test.ts`<br>`packages/polygon-agent-cli/src/lib/watch/evaluate.test.ts` | Real-filesystem watch store: due time, crossed-level refusal, uncovered token handling, input validation, 20-watch cap, session-mode sell target. | The hosted price and quote calls; those are stubbed. |
| CLI | `watch list` | no | GAP: no test yet | — | — | No test lists watches directly. |
| CLI | `watch cancel` | no | unit | `packages/polygon-agent-cli/src/commands/watch.test.ts` | Cancel and the schedule message, refusal to cancel twice, recurring check kept while a trade settles or an alert is owed. | Running the built binary. |
| CLI | `watch check` | yes | unit | `packages/polygon-agent-cli/src/lib/watch/check.test.ts`<br>`packages/polygon-agent-cli/src/commands/watch.test.ts` | Real-filesystem checks with injected dependencies: arming, one trade per arming, stale prices, expiry, locks, deadlines, never reporting a sent deposit as unsent, alerts delivered later. | A real quote or execution. |
| CLI | `watch run` | yes | GAP: no test yet | — | — | The loop and signal handling have no test. |
| CLI | `alerts` | no | unit | `packages/polygon-agent-cli/src/commands/watch.test.ts` | Lists unacknowledged alerts, acknowledges some or all, refuses to acknowledge an alert that is not open. | Running the built binary. |

## CLI: agent registry

Commands declared in `commands/agent.ts`.

**Totals (5 rows):** GAP 5

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `register` | gas only | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Needs a chain and a hosted relayer. |
| CLI | `identity` | no | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Needs a chain read. |
| CLI | `reputation` | no | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Needs a chain read. |
| CLI | `reviews` | no | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Needs a chain read. |
| CLI | `feedback` | gas only | GAP: needs a testnet/sandbox the providers do not offer today | — | — | Needs a chain and a hosted relayer. |

## CLI: Polymarket

Commands under `commands/polymarket/`; the hidden aliases `clob-buy`, `proxy-wallet` and `approve` fold into their targets.

**Totals (18 rows):** unit 10, weak 8

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| CLI | `polymarket setup` | approvals | weak | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/account.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/owner-step.test.ts` | Command tests mostly assert call arguments and counts with the Polymarket SDK, viem, bridge and wallet client mocked; dry-run step lists and restore decisions are asserted as output. | A real account, key or approval. |
| CLI | `polymarket status` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | Not-set-up report, summary of balance, approvals, orders and redeemable positions, paging sums and truncation, other trading keys. SDK is mocked. | Real balances. |
| CLI | `polymarket recover` | yes | weak | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | Refusals and call arguments with the SDK and wallet client mocked. | A real sweep. |
| CLI | `polymarket deposit` | yes | unit | `packages/polygon-agent-cli/src/commands/polymarket/funds.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/bridge.test.ts` | Amount refusals, pending-deposit record on disk, lock, dry run, failed and completed bridge entries, transfer calldata. Transaction primitive and bridge are mocked. | A real transfer or bridge. |
| CLI | `polymarket withdraw` | yes | weak | `packages/polygon-agent-cli/src/commands/polymarket/funds.test.ts` | Asserts mock call arguments; refusals (balance, bridge minimum) are asserted as codes. The withdraw library has no test. | A real transfer. |
| CLI | `polymarket markets` | no | weak | `packages/polygon-agent-cli/src/commands/polymarket/discover.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/gamma.test.ts` | Only the `--offset` refusal; the discovery helpers are mocked. The market data parser is tested separately. | Listing against a real service. |
| CLI | `polymarket event` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/discover.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/gamma.test.ts` | Open markets only by default. Resolver and market data are mocked. | A real service. |
| CLI | `polymarket market` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/discover.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/resolve.test.ts` | Falls back to listing an event slug. Resolver is mocked. | A real service. |
| CLI | `polymarket book` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/discover.test.ts` | Best-first sides. Market data is mocked. | A real service. |
| CLI | `polymarket history` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/discover.test.ts` | Downsampling to `--points`, last point kept. Market data is mocked. | A real service. |
| CLI | `polymarket buy` | yes | weak | `packages/polygon-agent-cli/src/commands/polymarket/trade.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/orders.test.ts` | Command test asserts that `broadcast:false` is passed on; the order library tests mock the account, deposits, region and SDK and assert mostly call arguments. | A real order. |
| CLI | `polymarket sell` | yes | weak | `packages/polygon-agent-cli/src/commands/polymarket/trade.test.ts`<br>`packages/polygon-agent-cli/src/lib/polymarket/orders.test.ts` | Command test asserts that `broadcast:true` and the minimum price are passed on; the order library is mocked as above. | A real order. |
| CLI | `polymarket orders` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/trade.test.ts` | Open orders in the summary shape. | Real orders. |
| CLI | `polymarket cancel` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/trade.test.ts` | `invalid_input` for no target or several; `--all --broadcast` cancels once; dry run lists and cancels nothing. | A real cancel. |
| CLI | `polymarket positions` | no | weak | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | Asserts that status, limit and cursor are passed through and printed back; legacy fallback and `not_set_up` failure. | Real positions. |
| CLI | `polymarket redeem` | yes | weak | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | De-duplication, partial failure, all-failed exit and truncation, asserted largely through mock calls with the SDK mocked. | A real redemption. |
| CLI | `polymarket activity` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | Maps activity rows. SDK is mocked. | Real activity. |
| CLI | `polymarket pnl` | no | unit | `packages/polygon-agent-cli/src/commands/polymarket/account.test.ts` | Value and last point. SDK is mocked. | Real data. |

## Worker: MCP tools

Tools registered in `packages/agentconnect-ui/worker/mcp.ts`. The tests call the tool handler against a fake key object, or the money modules directly against faked services; no test sends a tool call through the real key object. The real key object cannot run these in the Workers test runtime today, which is why the tool rows stay `unit` and name that gap.

**Totals (20 rows):** unit 19, GAP 1

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| Worker MCP | `get_wallet` | no | unit | `packages/agentconnect-ui/worker/mcp.test.ts` | Answers for the signed-in wallet only; the only tool listed for a connection with no allowance. | Balance reads from the real service. Through a real connection in the Workers runtime: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object (a connection cannot be created in that runtime). |
| Worker MCP | `get_allowance` | no | unit | `packages/agentconnect-ui/worker/mcp.test.ts` | Forwards a `status` request to a fake key object, and ChatGPT may call it without approval. | What the key object does with it. Through a real connection in the Workers runtime: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object (a connection cannot be created in that runtime). |
| Worker MCP | `send` | yes | unit | `packages/agentconnect-ui/worker/mcp.test.ts`<br>`packages/agentconnect-ui/worker/money/engine.test.ts` | Forwarded to the connection's own key with its wallet; refused without an allowance; engine caps (USD, on-chain, holdings, covered tokens), never-resend, deadline. | The tool wired through the real key object to the engine; a real transfer. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `swap_quote` | no | unit | `packages/agentconnect-ui/worker/money/trade.test.ts` | Quote validation, exact-output quotes, funding top-up, held-balance checks, against a faked swap service. | The tool-to-key dispatch; a real quote. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `swap` | yes | unit | `packages/agentconnect-ui/worker/money/trade.test.ts`<br>`packages/agentconnect-ui/worker/mcp.test.ts` | Deposit checked against the quote; key refusal returned as a readable tool error. | The tool-to-key dispatch; a real execution. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `swap_status` | no | unit | `packages/agentconnect-ui/worker/money/trade.test.ts` | Trade status handling against a faked swap service. | The tool-to-key dispatch. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `pay_service` | yes | unit | `packages/agentconnect-ui/worker/money/x402.test.ts` | Offer choice, public-https only, price over `max_usd` refused before funding, no redirects, nothing paid when nothing is asked. | The paid path (sign, fund, settle, uncertain outcome); the tool-to-key dispatch. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `earn_vaults` | no | unit | `packages/agentconnect-ui/worker/money/earn.test.ts` | Lists open, sizeable stablecoin vaults that take deposits, against a fake vault list. | The tool-to-key dispatch. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `earn_deposit` | yes | unit | `packages/agentconnect-ui/worker/money/earn.test.ts`<br>`packages/agentconnect-ui/worker/money/trade.test.ts` | Destination call checked against the quote; unlisted or closed vault refused before sending. | The tool-to-key dispatch; a real deposit. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `earn_withdraw` | yes | unit | `packages/agentconnect-ui/worker/money/earn.test.ts`<br>`packages/agentconnect-ui/worker/money/actions.test.ts` | Redeems all shares; refuses an unlisted vault or more than deposited; approval-only owner-wallet action hands its transactions over once. | Owner-wallet execution (`owner-run.ts` has no test file). The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_markets` | no | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Lists open markets as data. | A real service. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_account` | no | GAP: no test yet | — | — | No test reads the account through the tool. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_deposit` | yes | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Records the deposit before sending, waits for the balance, minimum, no second deposit while bridging, failure and unclear-outcome records. | A real transfer or bridge. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_buy` | yes | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Capped market order, refuses a worse fill, balance check before the owner is asked, closed market refused. | A real order. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_sell` | yes | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Limit order in whole cents of shares. | A real order. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_cancel` | no | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Cancels by market. | A real cancel. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_redeem` | yes | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Redeems each resolved market once. | A real redemption. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `polymarket_withdraw` | yes | unit | `packages/agentconnect-ui/worker/money/polymarket.test.ts` | Bridge minimum and balance, sends to the bridge address bound to the agent wallet. | A real transfer. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `propose_bundle` | yes | unit | `packages/agentconnect-ui/worker/mcp.test.ts`<br>`packages/agentconnect-ui/worker/money/actions.test.ts` | Several spends saved for one approval and nothing spent; a non-spending tool is refused; approved action runs once, declined never, expires after 15 minutes. | Bundle execution through the real key object and alarm. The tool run through the real key object: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker MCP | `get_action` | no | unit | `packages/agentconnect-ui/worker/money/actions.test.ts`<br>`packages/agentconnect-ui/worker/money/agent-key.workers.test.ts` | Outcomes: approved, declined, failed, expired, background run that never returned. In the Workers runtime: a declined request reads back as declined from the real key object. | The tool handler through a real connection: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object (a connection cannot be created in that runtime). |

## Worker: money HTTP routes

Routes in `worker/index.ts` that move or approve money.

**Totals (4 rows):** C 3, unit 1

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| Worker HTTP | `POST /api/connect/decide` | authorises spend | C | `packages/agentconnect-ui/worker/index.workers.test.ts`<br>`packages/agentconnect-ui/worker/index.test.ts`<br>`packages/agentconnect-ui/worker/money/connect.test.ts` | In the Workers runtime with the real OAuth provider and KV: a client registers, is sent to the connect page, and a deny from the signed-in owner returns `access_denied` with the caller's state; an anonymous request and another wallet's owner are refused. Unit tests: profile and spending-limit rules; allowance setup approves, checks and revokes what fails. | The allow path: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker HTTP | `GET /api/actions/:k/:a` | no | C | `packages/agentconnect-ui/worker/index.workers.test.ts`<br>`packages/agentconnect-ui/worker/money/actions.test.ts` | In the Workers runtime: refused without the owner's session cookie; with it, shows the pending request. Unit tests: action state and outcome logic. | — |
| Worker HTTP | `POST /api/actions/:k/:a` | yes | C | `packages/agentconnect-ui/worker/index.workers.test.ts`<br>`packages/agentconnect-ui/worker/money/actions.test.ts` | In the Workers runtime: refused without the session cookie, and without or with a foreign `Origin`, leaving the request pending; from this site the owner's decline is recorded. Unit tests: approve runs once in the background; an owner-wallet action cannot be approved without sign-in. | Approving and the run that follows, including the owner-wallet run: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| Worker HTTP | `DELETE /api/agents/:id` | no | unit | `packages/agentconnect-ui/worker/index.test.ts` | Disconnect revokes the connection's key; refused without the owner session or from another site. | Revocation against a real service. In the Workers runtime: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object (it needs a connection, which cannot be created in that runtime). |

## Durable Object lifecycles

State machines in the worker and the relay.

**Totals (2 rows):** C 2

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| DO | `AgentKey` (register, approve, spend, revoke, alarm queue) | yes | C | `packages/agentconnect-ui/worker/money/agent-key.workers.test.ts`<br>`packages/agentconnect-ui/worker/money/agent-key.test.ts`<br>`packages/agentconnect-ui/worker/money/engine.test.ts`<br>`packages/agentconnect-ui/worker/money/actions.test.ts` | In the Workers runtime with real storage: the key is sealed once (it opens only with the worker's secret), is never replaced and is not served to another wallet; revoke clears storage when the wallet service confirms or no longer accepts the key and keeps it when the service refuses, with register and revoke signed by the same key; the wallet store is first-wins with an exclusive lease that can be taken over once expired, separate per object; a declined request is stored as declined, is not queued and cannot be decided again. Unit tests: sessions kept only if they match the plan, one request at a time. | Approving a plan, every spend op (send, swap, pay, earn, Polymarket), the approved run and its alarm: GAP: the Workers test runtime cannot load modules on demand inside a Durable Object. |
| DO | `LoginSession` (register, action, status, alarm expiry) | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/login-session.test.ts` | In the Workers runtime with real storage: sessions are isolated by id; registering sets an expiry alarm about ten minutes out; when the alarm fires the stored session is cleared, status reads `expired` and no alarm remains. Core logic also unit-tested. | — |

## oidc-relay routes

Routes in `packages/oidc-relay/src/relay.ts`. The Workers-runtime tests call the worker's fetch handler against the real `LoginSession` Durable Object, with no mocks; the validators and session logic beneath also have unit tests.

**Totals (8 rows):** C 8

| Surface | Command / op | Moves money | Verdict | Where | Asserted | Not asserted, and why |
|---|---|---|---|---|---|---|
| Relay | `OPTIONS *` | no | C | `packages/oidc-relay/src/relay.workers.test.ts` | Preflight answers 204 with the allowed headers. | Preflight on every individual path. |
| Relay | `GET /` and `GET /health` | no | C | `packages/oidc-relay/src/relay.workers.test.ts` | `/health` answers 200 with its JSON body and the CORS header. | `GET /` is not requested separately. |
| Relay | `POST /api/login/register` | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/login-session.test.ts` | Invalid JSON and a malformed session id answer 400, with CORS on the error; a valid register answers 204 and arms the session; an invalid context is dropped, not rejected. | — |
| Relay | `POST /api/login/action` | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/relay.test.ts` | Unknown action type and a callback on a foreign host answer 400; 410 `expired` before register; 204 once registered; 410 `finished` after the login is done. | — |
| Relay | `GET /api/login/next-action` | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/login-session.test.ts` | An action is handed over once, then `pending`; another session never sees it; a malformed session id answers 400. | — |
| Relay | `POST /api/login/status` | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/login-session.test.ts` | An invalid status answers 400; a valid `done` answers 204 and is read back. | A status posted before register. |
| Relay | `GET /api/login/status` | no | C | `packages/oidc-relay/src/relay.workers.test.ts`<br>`packages/oidc-relay/src/login-session.test.ts` | Status and context read back per session; an unknown session reads `expired`; a malformed session id answers 400 with an error status. | — |
| Relay | 404 fallback | no | C | `packages/oidc-relay/src/relay.workers.test.ts` | An unknown path answers 404. | — |
