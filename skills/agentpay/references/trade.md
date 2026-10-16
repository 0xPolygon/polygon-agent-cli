# Trade: buy, sell, swap, bridge

**When to use:** the user wants to buy, sell or swap a token, or move one to another chain. For a trade that should happen when a price is hit, read [watches](watches.md). For yield, read [earn](earn.md).

**Before you start:** `"$POLYGON_AGENT" wallet status` shows `connected: true` and an allowance that covers the trade (otherwise [connect](connect.md)). Every buy, sell, swap or bridge goes through `swap`, which trades through Trails. For a request the allowance covers, get a quote before telling the user a trade isn't possible.

## Read the request

Read the amount the way the user said it, and sell what the wallet actually holds: take the token and chain from `holdings` in `wallet status`, not from the table (the user's BTC may be cbBTC on Base: `--from cbBTC --chain base`).

| The user says | Run |
|---|---|
| "Buy 10 POL" (an amount of the token) | `swap --to POL --to-amount 10` |
| "Buy $50 of ETH" (an amount in dollars) | `swap --to ETH --amount-usd 50` |
| "Sell 0.1 ETH" (held as WETH on Polygon) | `swap --from WETH --amount 0.1` |
| "Sell $20 of BTC" | `swap --from WBTC --amount-usd 20` |
| "Sell half my ETH", "Sell all my POL" | `swap --from WETH --amount 50%`, `swap --from WPOL --amount all` |
| "Swap 5 USDC for USDT" | `swap --from USDC --to USDT --amount 5` |
| "Move 20 USDC to Base" (a bridge) | `swap --from USDC --to USDC --chain polygon --to-chain base --amount 20` |

```sh
"$POLYGON_AGENT" swap --to POL --to-amount 10 --dry-run              # buy 10 POL (at least)
"$POLYGON_AGENT" swap --to WETH --amount-usd 50 --dry-run            # buy $50 of ETH
"$POLYGON_AGENT" swap --from WETH --to USDC --amount 50% --dry-run   # sell (on Polygon; --chain for another)
"$POLYGON_AGENT" swap --from USDC --to USDT --amount 5 --slippage 0.005 --dry-run   # custom slippage (default 0.5%)
"$POLYGON_AGENT" swap --intent <intentId> --broadcast                # execute a quote the user accepted
"$POLYGON_AGENT" swap status --intent <intentId>                     # follow one still in progress
```

Bridges take `--to-chain`: `polygon`, `amoy`, `mainnet`, `arbitrum`, `optimism`, `base`. Always pass `--dry-run` or `--broadcast`.

## Quote, then execute

- **Show the quote first:** what's sold and bought (`sell`, `buy.expected`, `buy.minimum`), `feesUsd`, `priceImpact` and `quoteExpiresAt`. Execute with the `command` it prints once the user agrees. If the user's instruction was already precise ("buy $50 of ETH now"), you may go straight to `--broadcast`; the CLI still refuses a quote that costs over 10% in fees or price impact, or that pays with a token the user didn't name (`confirmation_required`). A buy by token amount (`--to-amount`) always needs its quote accepted, since its cost is only known from the quote. Show that quote and run its `command` only if the user accepts it.
- **What pays for a buy.** Leave out `--from` unless the user named what to pay with. The CLI prefers stablecoins that look sufficient (USDC, then USDT or USDG). If stablecoin balances look too small or their quotes fail, it can quote another token the wallet holds (WETH, WPOL, …, never the one being bought) and adds a warning saying so. Tell the user what it would sell; that quote runs only once they accept it (`confirmation_required` until then).
- **Keep the quantity the user asked for.** Don't round it up, or spend the whole balance instead. A `--to-amount` quote guarantees at least that much (`buy.minimum`) and may deliver a little more (`buy.expected`); tell the user both. If the wallet can't cover it (`insufficient_balance`), tell the user what it holds and offer the most it can buy (quote that), or funding ([wallet](wallet.md)).
- **Buys of ETH or POL deliver WETH or WPOL.** Say so briefly: "you'll get WPOL, wrapped POL, the same value in the form I can trade with". Native ETH and POL can't be spent by you, so they can't pay for a buy either.

## Errors

- **An incomplete funding search is not insufficient funds.** On `quote_search_incomplete`, run its `command` (or a command from `untriedSources`) through the workspace wrapper. It preserves the request and always uses `--dry-run`. Show what would be sold and get approval before executing that quote.
- `quote_unavailable` means Trails could not provide a usable quote, not necessarily that no route exists. A missing price or unavailable service means affordability is unknown; follow its hint instead of asking the user to fund the wallet.
- No route found: insufficient liquidity for the pair. Try a different amount or token pair.

## What to tell the user

Outcome first, amounts in tokens and USD, chains by name, the transaction link from the output. For example: "Done. You bought 0.02 ETH for $50."
