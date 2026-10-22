# Wallet: balances, address, funding, sending

**When to use:** the user asks what they hold, a token's price, the wallet address, how to add funds, or to send tokens to an address. For trades read [trade](trade.md); for price alerts read [watches](watches.md).

**Before you start:** `"$POLYGON_AGENT" wallet status` shows `connected: true` (otherwise [connect](connect.md)).

## Balances and prices

```sh
"$POLYGON_AGENT" wallet status                  # holdings on every supported chain, and whether you can spend them
"$POLYGON_AGENT" balances --chains polygon,base # balances on the chains named (Polygon only, without --chains)
"$POLYGON_AGENT" price ETH                      # ETH, BTC, POL and stablecoins need no chain
"$POLYGON_AGENT" price <symbol-or-address> --chain base
```

Holdings marked `not_covered`, `native_not_spendable` or `limit_used`: tell the user what's there and that you can't spend it. Offer to cover a token or chain with a new sign-in ([connect](connect.md), `wallet allowance set --add <token>@<chain>`). Native coins (ETH, POL, BNB, AVAX) can't be covered.

Present balances as a short list or table of token and amount (with USD), chains by name. Never paste the JSON.

## The wallet address

Whenever you give the user the wallet address (after connecting, for funding, or when they ask), end your message with "Your agent wallet address is:" and send the full address as the next message, with nothing else in it, so they can copy it in one go. Never shorten it. If your platform sends only one message per reply, put the address alone on its own line. `"$POLYGON_AGENT" wallet address` returns just the address. It's the same on every chain.

## Funding

`dashboard.url` from `"$POLYGON_AGENT" wallet status` is the wallet's page, where the user adds funds; send it in full: "You can see your wallet and add funds here: <dashboard.url>". Recommend USDC on Polygon; any covered token on a covered chain works. Funds in anything else show as not spendable by you. Ask them to tell you once they've sent it, so you can check it arrived.

`"$POLYGON_AGENT" fund` opens that page in a browser on this machine, so use it only when the user is at this machine and asks for it. Never build the URL yourself or hardcode an address.

When any output has `funding`, send `funding.url` with a few words on what it's for. Nothing opens on its own. A connect to a wallet with no funds sets `funding.reason` to `empty`. A shortfall error (`insufficient_balance`, for gas or a Polymarket deposit) has no `reason`; its `funding.amountUsd`, when present, is how much is missing.

## Send

Only on the user's explicit instruction, reading the address back to them first:

```sh
"$POLYGON_AGENT" send-token --symbol USDC --to <address> --amount 5 --chain polygon --dry-run
"$POLYGON_AGENT" send-token --symbol USDC --to <address> --amount 5 --chain polygon --broadcast
```

Always pass `--dry-run` or `--broadcast`; the CLI's default is a preview, so never rely on it. Sending a native coin isn't possible from an allowance (`native_not_supported`). To move funds to the user's own wallet beyond the allowance, use `wallet withdraw` ([connect](connect.md)).

Report the outcome in one line, for example "Done. Sent 5 USDC to 0x12…ab on Polygon." with the transaction link from the output.
