---
'@polygonlabs/agent-cli': minor
---

Buying a token amount, paying with other holdings, and assistant skill fixes from Muse QA:

- `swap --to-amount <n>` buys at least that much of `--to` ("buy 10 POL"), using a Trails exact-output quote; more decimals than the token has are refused. The deposit is the quoted input, so the quote must guarantee the amount asked for, and it's never executed in one step: the user accepts it by its intent (`confirmation_required`). Estimates only rank candidates, including near-miss stablecoins and sufficiently funded holdings ahead of dust balances. Actual quotes decide affordability. A bounded search reports untried sources with ready-to-run preview commands instead of declaring insufficient funds.
- Without `--from`, a buy in USD or by `--to-amount` falls back to another covered token the wallet holds (largest first, never the token bought) when stablecoin balances look too small or quotes fail. Such a quote is never executed in one step (`confirmation_required`). Watches' auto trades still pay only with stablecoins. A holding that can't be priced makes the answer unknown (`upstream_unavailable`), not `insufficient_balance`. In owner mode, WPOL or WETH can pay for native POL or ETH. Destination precision is validated on the selected chain, and malformed source amounts are rejected before funding discovery.
- `wallet confirm` no longer prints `worstCase`.
- The `polygon-oms-wallet` skill and `setup.md`: how to read buy and sell requests, the wallet address as a message of its own, a plainer connect message, and how to raise the limit with a new code.
- Expected Trails quote failures are structured errors with reasons and preview commands. Query failures and high-price-impact refusals can try another source without relaxing limits; outages and invalid quotes stop immediately. Dollar buys, including automatic watches, may use another covered chain when no destination chain is specified. Incomplete watch searches remain armed.
