# CLI reference: every command and flag

**When to use:** you need a command or flag that isn't in the task's own reference. The task references ([wallet](wallet.md), [trade](trade.md), [polymarket](polymarket.md), …) come first; this is the full list. Commands are written `agent …`: run them as `"$POLYGON_AGENT" …`. Check `--help` on any command for its exact flags.

### Setup
```bash
agent setup [--name <name>] [--force]
  [--oms-publishable-key <key>] [--oms-project-id <proj_...>]  # save OMS credentials (project id optional/legacy)
agent mode [auto|dry-run]   # show or set the persisted transaction mode
```

### Wallet
Valid `--chain` values for operations: a chain name or ID, e.g. `polygon` (default), `amoy` (Polygon testnet), `mainnet` (Ethereum), `arbitrum`, `optimism`, `base`, `bsc`, `avalanche`, `katana`. ERC-8004 agent operations only support `polygon`. The embedded wallet address is the same on every chain.

```bash
agent wallet login --owner [--name <n>] [--local] [--no-fund] [--force]
# Owner sign-in. Opens the agentconnect login page; choose Google or email. Bare `wallet login` (no --owner) is session mode. Works whether the browser is local or remote, so there is no separate headless mode.
# --local (owner only) falls back to the legacy loopback flow (raw Google URL + localhost callback; browser must be on this machine; Google only). --remote is deprecated (now a no-op with a notice).
agent wallet logout [--name <n>]   # owner mode: clears the local session; session mode: revokes this install's access
agent wallet list
agent wallet address [--name <n>]
agent wallet remove [--name <n>]

# Session mode (an allowance approved by signing in; see Session Mode)
agent wallet login [--email <email>] [--allowance <usd>] [--days <1-30>] [--chains <csv>]   # picks browser or chat code
agent wallet login --wait                                 # wait for a browser sign-in
agent wallet confirm --request <id> (--code <code> | --wait)
agent wallet status                                       # start here
agent wallet allowance                                    # show it
agent wallet allowance set [--amount <usd>] [--add <token>[@<chain>]] [--chains <csv>]   # new sign-in
agent wallet allowance renew [--days <n>]                 # new sign-in
agent wallet withdraw --to <addr> --token <SYM> --amount <n> [--chain <chain>]           # as the owner; new sign-in
agent wallet access [--revoke <credentialId>] [--session <id>]                           # new sign-in
agent wallet link-credentials [--email <email>]                                          # new sign-in: saved address and cards
```

### Operations
```bash
agent balances [--wallet <n>] [--chain <chain>] [--chains <csv>]
agent send --to <addr> --amount <num> [--symbol <SYM>] [--token <addr>] [--decimals <n>] [--broadcast]
agent send-native --to <addr> --amount <num> [--broadcast] [--direct]
agent send-token --symbol <SYM> --to <addr> --amount <num> [--token <addr>] [--decimals <n>] [--broadcast]
agent swap --to <SYM> (--amount <num|n%|all> | --amount-usd <usd> | --to-amount <num>) [--from <SYM>] [--chain <chain>] [--to-chain <chain>] [--slippage <num>] [--broadcast]
agent swap --intent <intentId> --broadcast          # execute a quote from a dry run
agent swap status --intent <intentId>               # follow a trade still in progress
agent deposit --asset <SYM> --amount <num> [--protocol aave|morpho] [--vault <addr>] [--chain <c>] [--broadcast]
agent credentials address [--name ... --line1 ... --city ... --state ... --zip ... --country ...] [--clear]
agent credentials status | cards | cards add | cards wait --session <id>
agent buy "<what>" | --conversation <id> "<answer>" | --approval <id> --wait     # shopping reference
agent checkout --merchant <store> --url <page> --total <usd> [--item "1x Name"]
agent withdraw --position <addr> --amount <num|max> [--chain <chain>] [--broadcast]
agent fund [--wallet <n>]
agent x402-pay --url <url> --wallet <n> [--chain <chain>] [--method GET] [--body <str>] [--header Key:Value] [--max-usd <usd>] [--yes] [--broadcast] [--dry-run]
```

### Polymarket
```bash
agent polymarket status                              # start here: setup, balance, region, redeemable
agent polymarket setup [--broadcast]                 # create the account (no POL needed)
agent polymarket deposit <usd> [--again] [--no-wait] [--broadcast]   # min $2; counts against a session allowance
agent polymarket withdraw <usd|all> [--broadcast]    # pays the agent wallet as USDC
agent polymarket markets [--search <text>] [--limit <n>] [--cursor <c>]
agent polymarket event <slug> | market <ref> | book <ref> <outcome> | history <ref> <outcome>
agent polymarket buy <ref> <outcome> <usd> [--max-price <0-1>] [--price <0-1>] [--expires <min>] [--broadcast]
agent polymarket sell <ref> <outcome> <shares|all> [--min-price <0-1>] [--price <0-1>] [--expires <min>] [--broadcast]
agent polymarket orders [--market <ref>] | cancel [<orderId>|--all|--market <ref>] [--broadcast]
agent polymarket positions [--status OPEN|REDEEMABLE|...] | redeem [<ref>|--all] [--broadcast] | activity | pnl
```
Full guide: [polymarket](polymarket.md).

### Prices, watches and alerts
```bash
agent price <SYM|address> [--chain <chain>]       # ETH, BTC, POL and stablecoins need no chain
agent watch create --token <SYM> --mode alert|auto [--buy-below <usd>] [--buy-amount <usd>] [--sell-above <usd>] [--sell-amount <n|n%|all>] [--chain <chain>] [--every 15m] [--expires 30d] [--confirm]
agent watch list [--all]
agent watch cancel <id>
agent watch check                                 # run on a schedule (the output's `schedule` says how often)
agent watch run                                   # or check in the foreground until stopped
agent alerts [--all]                              # unacknowledged alerts
agent alerts --ack [id…]
```

### Workspace installs
```bash
agent workspace init --root <workspace>/.polygon-agent [--skills-dir <dir>] [--name <install name>] [--platform <muse|openclaw|hermes|grok|claude-code|cursor|codex|other>]
agent skills [show <open-money-agent|topic> | install open-money-agent --dir <dir>]   # topic: a reference, e.g. polymarket
agent update                                      # workspace installs: latest CLI, refreshed skill
```

Every write command accepts `--broadcast` (execute) and `--dry-run` (force preview); with neither, the persisted `agent mode` decides.

### Agent identity & reputation (ERC-8004)
```bash
agent register --name <n> [--agent-uri <uri>] [--metadata <k=v,k=v>] [--broadcast|--dry-run]
agent identity --agent-id <id> [--key <metadata-key>]   # agent payment wallet + optional metadata
agent reputation --agent-id <id> [--tag1 <tag>] [--tag2 <tag>]
agent reviews --agent-id <id> [--tag1 <t>] [--tag2 <t>] [--include-revoked]
agent feedback --agent-id <id> --value <score> [--tag1 <t>] [--tag2 <t>] [--endpoint <e>] [--feedback-uri <uri>] [--broadcast|--dry-run]
```

**ERC-8004 contracts (Polygon mainnet):**
- IdentityRegistry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- ReputationRegistry: `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Key behaviors

- **Transaction mode** — in the default `dry-run` mode, write commands preview and require `--broadcast` to execute. `agent mode auto` persists always-broadcast; `--dry-run` on any command forces a preview regardless of mode. After the first `wallet login`, if the login JSON contains a `modePrompt` field, relay that question to the user and run `agent mode auto` or `agent mode dry-run` per their answer before continuing. Never enable auto mode without the user's explicit answer.
- **Smart defaults** — `--wallet main`, `--chain polygon`
- **`balances --chains`** — comma-separated chains (max 20); two or more return JSON with `multiChain: true` and a `chains` array (same wallet address on each)
- **Fee preference** — auto-selects USDC over native POL when both available; the relayer pays gas in whichever fee token the wallet can afford
- **`fund`** — opens the wallet's agentconnect page in a browser on this machine (the only command that opens it) and returns it as `url`, with the wallet and chain prefilled. Use it when the user wants the page opened here; otherwise send `dashboard.url` from `wallet status` (or `funding.url` when an output has one). Never hardcode or construct the URL.
- **`deposit`** — picks highest-TVL pool via Trails `getEarnPools` and deposits directly. Full deposit reference: [earn](earn.md).
- **Gas reserve** — when using `deposit` or any command that spends tokens, always reserve at least 0.1 USDC or 0.1 POL in the wallet for gas. Never attempt to spend the full balance. The `deposit` command enforces a 0.1 reserve automatically, but the agent must apply the same rule when constructing amounts for `send`, `swap`, or direct contract calls.
- **`withdraw`** — `--position` = aToken or ERC-4626 vault; `--amount` = `max` or underlying units (Aave / vault). Dry-run JSON includes `poolAddress` / `vault`.
- **`x402-pay`** — probes the endpoint for 402 and previews the selected payment by default. In auto mode or with `--broadcast`, the wallet funds a builder EOA with the exact token amount and completes the payment. Chain auto-detected from the 402 response. `--max-usd` refuses a higher price; without it, a price over `x402_max_per_call` ($1) fails with `confirmation_required` until rerun with `--yes`, and `x402_daily_max` ($10, rolling 24 hours) caps the total. In session mode the funding transfer comes out of the allowance
- **`swap`** — quotes through Trails; a dry run saves the quote and prints its `intentId` and the command to execute it. `--amount` takes a number, `<n>%` or `all`; `--amount-usd` sells a USD value; `--to-amount` buys at least that much of `--to` ("buy 10 POL"; more decimals than the token has are refused). Without `--from`, a buy pays with a stablecoin that has enough balance; for `--amount-usd` or `--to-amount`, it can prefer another sufficiently funded token over dust stablecoins or fall back after quote failures (never the one bought). A quote paying with such a holding, or any `--to-amount` buy, isn't executed in one step: it returns `confirmation_required` with the command to accept it
- **Funding search** — swaps try up to three eligible funding sources. `quote_search_incomplete` lists `untriedSources` with chain IDs, names and preview commands; its top-level `command` previews the first untried source, preserving the original request. Show it for approval. `quote_unavailable` includes the upstream reason without a stack trace; it does not assert that no route exists. This does not mean the wallet lacks funds. Quote estimates never exclude an exact-output funding source; actual quote costs decide.
- **Watches** — `watch check` reads all prices in one call, raises an alert or trades (`--mode auto`) when a level is crossed, and re-arms after a 2% move back. They only run when checked: schedule `watch check` with the agent's scheduler
- **`call`** — submit arbitrary pre-encoded calldata: `agent call --to <addr> --data 0x... [--value <amt>] [--prefer-native-fee] [--broadcast]`. The wallet can call any contract (no permission scoping in the V3 model)
- **`send-native --direct`** — bypasses ValueForwarder contract for direct EOA transfer
- **No permission scoping (owner mode)** — the V3 embedded wallet can call any contract and spend any amount it holds; there are no per-contract whitelists or spend limits. Guard spending in agent logic, not at the wallet layer.
- **Session expiry** — ~1 week from login; on expiry, re-run `wallet login --owner` (owner mode)

## Presenting results

CLI commands output JSON (non-TTY). After running a command, always render the result as formatted markdown — never paste raw JSON into the conversation.

| Command | How to present |
|---------|---------------|
| `balances` | Markdown table: Token / Balance columns. Show wallet address and chain above the table. |
| `send` / `send-token` / `send-native` | One-liner summary: amount, symbol, recipient. If broadcast, show tx hash as a code span and explorer URL as a link. |
| `swap` | Summary: `X FROM → Y TO` with chain. If broadcast, show deposit tx hash + explorer link. |
| `deposit` | Summary: amount, asset, protocol, pool address. If broadcast, show tx hash + explorer link. |
| `withdraw` | Summary: `kind` (aave / erc4626), position, amount, pool or vault. If broadcast, show tx hash + explorer link. |
| `fund` | Show the `url` as a clickable link with a brief instruction to open it. |
| `wallet login` / `wallet list` | Wallet name, truncated address, chain in a small table or bullet list. |
| `register` | Show agent name and tx hash as a code span with Polygonscan link. Remind user to retrieve `agentId` from the Registered event on the Logs tab. |
| `identity` | Show `agentId`, wallet address, whether a wallet is set, and the decoded metadata value when `--key` was passed. |
| `reputation` | Format score and tag breakdown as a small table. |

**Dry-run results** — always make it visually clear this was a simulation. Prefix with `⚡ Dry run` and show what *would* happen. Remind the user to re-run with `--broadcast` to execute.

**Errors** — extract the `error` field and present it as a clear sentence, not a JSON blob. Include the relevant fix from the Troubleshooting table if applicable.
