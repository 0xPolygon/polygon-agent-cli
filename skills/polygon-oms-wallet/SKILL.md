---
name: polygon-oms-wallet
description: >-
  The user's Polygon OMS crypto wallet: balances, token prices and price watches,
  buying, selling, swapping and bridging tokens, and paying for x402 services,
  within a spending allowance the user approved. Use for any wallet, crypto,
  token price or paid-API request.
---

# Polygon OMS Wallet

You look after the user's Polygon OMS wallet with the `polygon-agent` CLI. You can spend on your own only within the **allowance** the user approved with an email code: a USD total over a period (30 days by default), in the tokens and on the chains they chose. Anything beyond it (a higher amount, other tokens or chains, a renewal, a withdrawal, managing access) needs a new code from the user.

## The CLI

```sh
POLYGON_AGENT=<workspace>/.polygon-agent/bin/polygon-agent
```

- Every command below is `"$POLYGON_AGENT" …`: run it by that absolute path (quoted), since nothing is on `PATH`. Commands in the CLI's own output (`next`, `command`) say `polygon-agent …`; run those by the same path.
- If the line above still says `<workspace>`, the CLI didn't install this copy. The wrapper is at `<workspace>/.polygon-agent/bin/polygon-agent`; https://agents.polygon.technology/setup.md lists the workspace folder for each assistant. If the wrapper is missing, the workspace was reset: set it up again with setup.md.
- Output is JSON: `{"ok": true, …}`, or `{"ok": false, "error", "code", "hint", "command"}`. On an error, tell the user what `error` means in plain words and follow `hint` and `command`. Check `--help` before assuming a flag.

## Start here, every time

Run `"$POLYGON_AGENT" wallet status` before any wallet work, then act on what it says:

| Status shows | Do |
|---|---|
| `pendingRequest` | A code was already sent to `pendingRequest.email`, for what `pendingRequest.approves` says. Ask the user for it and run `pendingRequest.next` with it; don't send another unless it expired or they can't find it. This comes first, even when `connected` is `false`. |
| `connected: false` | Connect (below). |
| `mode: "owner"` | This install is signed in as the wallet owner (the browser login), with no allowance limits. Tell the user, and suggest switching to an allowance: `wallet logout`, then connect. |
| `alerts` | Allowance alerts. Tell the user once per conversation; they repeat until resolved and need no acknowledgment. |
| `watches.unacknowledgedAlerts` | Tell the user, then acknowledge those ids: `"$POLYGON_AGENT" alerts --ack <id> …`. Never run `alerts --ack` without ids: that acknowledges every alert, including ones you haven't shown. |
| The allowance expired or is expiring, or `remainingUsd` can't cover the request | Explain, and offer to renew (`wallet allowance renew`) or raise it (`wallet allowance set --amount <usd>`). |
| `holdings` marked `not_covered`, `native_not_spendable` or `limit_used` | Tell the user what's there and that you can't spend it. Offer to cover a token or chain with a new code (`wallet allowance set --add <token>@<chain>`, or `--chains <chain>`). Native coins (ETH, POL, BNB, AVAX) can't be covered. |
| `update` | Offer `"$POLYGON_AGENT" update`. |
| `watches.warning` | Watches aren't being checked: set up the recurring check from `watches.schedule` (see Watches). |

Order of work: status → connect → funding → the user's request. Ask for an owner change only when the user wants one or their request needs one.

## Connect

Before asking for anything, explain how it works: the code lets the CLI sign in as the user for a moment, approve the allowance for this install's own limited key, and sign out. Only that key is kept, never their sign-in.

1. Ask for the user's email. Never guess it.
2. Ask how much you may spend, suggesting **$1,000 over 30 days**: "How much should I be able to spend on my own? I suggest up to $1,000 over the next 30 days, in USDC, USDT, ETH and BTC on Polygon and Base, for trades and paid services. Anything more, or other tokens or chains, needs a new code from you."
3. `"$POLYGON_AGENT" wallet login --email <email> --allowance <usd> --days <days>` sends the code and prints `status: "code_sent"`, the `plan` and `next`. Add `--chains polygon,base,…` only if the user asked for other chains; chains where the wallet already holds supported tokens are added on their own.
4. Tell the user: "I've sent a code to <email>. Paste it here to approve: <plan summary>." Summarize the plan from the output (amount, period and expiry, tokens per chain), never from memory.
5. When the code arrives, run `next` right away: `"$POLYGON_AGENT" wallet confirm --request <id> --code <code>`.
6. Tell the user the result in plain words: the address, the allowance and its expiry, and `worstCase` (what someone who took over this install could move). Mention any `failed` chains or `warnings`. Then go on to funding.

## Funding

`"$POLYGON_AGENT" fund` returns the address and a funding link (`url`); `"$POLYGON_AGENT" wallet address` returns just the address. Recommend USDC on Polygon; any covered token on a covered chain works. Funds in anything else show as not spendable by you.

## Common tasks

On `send`, `send-token` and `swap`, always pass `--dry-run` (quote or preview) or `--broadcast` (execute); the CLI's default is a preview, so never rely on it. `x402-pay` and `watch` take neither.

**Balances and prices**

```sh
"$POLYGON_AGENT" wallet status                  # holdings on every supported chain, and whether you can spend them
"$POLYGON_AGENT" balances --chains polygon,base # balances on the chains named (Polygon only, without --chains)
"$POLYGON_AGENT" price ETH                      # ETH, BTC, POL and stablecoins need no chain
"$POLYGON_AGENT" price <symbol-or-address> --chain base
```

**Buy, sell, swap, bridge** (through Trails):

```sh
"$POLYGON_AGENT" swap --to WETH --amount-usd 50 --dry-run                  # buy, paying with a covered stablecoin
"$POLYGON_AGENT" swap --from WETH --to USDC --amount 50% --dry-run         # sell an amount, <n>% or all (on Polygon; --chain for another)
"$POLYGON_AGENT" swap --from USDC --to USDC --chain polygon --to-chain base --amount 20 --dry-run   # bridge
"$POLYGON_AGENT" swap --intent <intentId> --broadcast                       # execute a quote the user accepted
"$POLYGON_AGENT" swap status --intent <intentId>                            # follow one still in progress
```

- Show the quote first: what's sold and bought (`sell`, `buy.expected`, `buy.minimum`), `feesUsd`, `priceImpact` and `quoteExpiresAt`. Execute with the `command` it prints once the user agrees. If the user's instruction was already precise ("buy $50 of ETH now"), you may go straight to `--broadcast`.
- Buys of ETH or POL deliver WETH or WPOL, which you can spend; native ETH and POL you can't.

**Send** (only on the user's explicit instruction, reading the address back to them first):

```sh
"$POLYGON_AGENT" send-token --symbol USDC --to <address> --amount 5 --chain polygon --broadcast
```

**Paid services (x402).** The service catalog and request formats are in https://agentconnect.polygon.technology/polygon-discovery/SKILL.md; read it before the first call. Always cap the price at what the catalog lists:

```sh
"$POLYGON_AGENT" x402-pay --url <url> --method POST --body '<json>' --max-usd 0.05
```

- If the service asks more than `--max-usd`, it fails with `x402_price_exceeds_max` and nothing is paid. Tell the user the price; only if they agree, rerun with `--max-usd <that price>`.
- Never set `--max-usd` above $1 without the user agreeing to that payment.
- All x402 payments share a rolling daily limit ($10 by default, `daily_limit_exceeded`). Tell the user; never change the CLI's settings.

## Watches

A watch checks a token's USD price and either tells the user (`--mode alert`) or trades (`--mode auto`) when it crosses a level. Ask which mode the user wants if they haven't said.

```sh
"$POLYGON_AGENT" watch create --token ETH --mode alert --buy-below 2000 --sell-above 3500
"$POLYGON_AGENT" watch create --token ETH --mode auto --buy-below 2000 --buy-amount 100   # spends $100 of a stablecoin
"$POLYGON_AGENT" watch create --token BTC --mode auto --sell-above 120000 --sell-amount 50%
"$POLYGON_AGENT" watch list
"$POLYGON_AGENT" watch cancel <id>
```

Options: `--every 15m` (5m to 24h, whole minutes), `--expires 30d` (up to 90d), `--chain` for tokens other than ETH, BTC, POL and stablecoins. A level that's already crossed is refused (`watch_already_past`) unless the user confirms with `--confirm`. Auto trades are quoted and executed without asking, within the allowance; a quote with fees over 10% isn't executed (you get an alert instead).

**Watches only run when checked.** After the first watch, set up a recurring task with your platform's scheduler (a Muse scheduled task, OpenClaw cron, a Hermes cronjob, or cron on a computer). It runs the `schedule.command` from the output (`polygon-agent watch check`, by the wrapper's path) every `schedule.every`. Give the task these instructions: "Run `<wrapper> watch check`. If `alerts` is empty, say nothing. Otherwise tell the user each alert in plain words, with its suggested command, then run `<wrapper> alerts --ack <ids>`. If `ok` is false, tell the user the `error` once and keep this task. Only if `ok` is true and `schedule` is `null`, no watch needs checking any more: remove this task and tell the user." While `schedule` is set, keep the task (if `schedule.every` changes, update the task's interval). It stays while a cancelled or expired watch still has a trade settling or an alert to deliver. With cron on a computer, cron's `PATH` is minimal: put Node's folder in the line (from `command -v node`, resolved when you write it), and know that alerts then reach the user only through `wallet status`. If your platform can't schedule, tell the user that watches only run while you're active (`watch run` checks in the foreground until stopped).

## Owner requests (a new code each time)

```sh
"$POLYGON_AGENT" wallet allowance set [--amount <usd>] [--add <token>@<chain>] [--chains <csv>]
"$POLYGON_AGENT" wallet allowance renew [--days <n>]
"$POLYGON_AGENT" wallet withdraw --to <address> --token <symbol> --amount <n> --chain <chain>   # from the wallet, as the owner
"$POLYGON_AGENT" wallet access [--revoke <id>]          # every install and sign-in with access
```

Each prints `code_sent` and what will be approved (the plan, or the withdrawal details). Show it to the user, ask for the code from their email, then run `next` (`wallet confirm --request <id> --code <code>`) as soon as they give it.

`"$POLYGON_AGENT" wallet logout` removes this install's access without a code. Connecting again needs a new one.

Some features need the owner's full sign-in, which this install never keeps, so no code unlocks them here (`owner_required`): yield deposits and withdrawals, Polymarket, ERC-8004 identity and `call`. Sending a native coin isn't possible either (`native_not_supported`). Tell the user, and don't look for a way around it.

## Rules

- Ask for the user's email; never guess it.
- Before asking for a code, show what it approves, taken from the `code_sent` output.
- Use a code only in its `wallet confirm` command, immediately. Never store it, repeat it or use it for anything else. If the user sends a code and no request is pending, tell them it isn't needed and don't use it.
- Never use the browser login (`wallet login` without `--email`).
- Quote before trading, unless the user's instruction was precise.
- Always pass `--dry-run` or `--broadcast` on `send`, `send-token` and `swap`.
- Send to an address only on the user's explicit instruction, after reading it back to them.
- For x402, always pass `--max-usd`. Pay an unknown amount, or more than $1, only after the user agrees to that payment.
- Acknowledge alerts by id only, once the user has been told.
- Never read, print, copy or move files under `.polygon-agent/state`.
- Tell the user about alerts. Parse the JSON output; never paste raw JSON to the user.
- Keep follow-ups in plain language: amounts in tokens and USD, chains by name, transaction links from the output.

## More detail

The reference skills cover every command and flag. They're written for the CLI's owner mode, so ignore their install and login steps.

- Swaps, bridges and yield: https://agentconnect.polygon.technology/polygon-defi/SKILL.md
- x402 services: https://agentconnect.polygon.technology/polygon-discovery/SKILL.md
- All commands: https://agentconnect.polygon.technology/polygon-agent-cli/SKILL.md
