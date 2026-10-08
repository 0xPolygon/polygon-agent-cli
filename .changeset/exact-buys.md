---
'@polygonlabs/agent-cli': minor
---

Buying a token amount, paying with other holdings, and assistant skill fixes from Muse QA:

- `swap --to-amount <n>` buys at least that much of `--to` ("buy 10 POL"), using a Trails exact-output quote; more decimals than the token has are refused. The deposit is the quoted input, so the quote must guarantee the amount asked for, and it's never executed in one step: the user accepts it by its intent (`confirmation_required`). Estimates only rank the tokens that could pay; each quote is checked against that token's balance and allowance left, and the next token is quoted when one falls short (up to three).
- Without `--from`, a buy in USD or by `--to-amount` falls back to another covered token the wallet holds (largest first, never the token bought) when no stablecoin holds enough. Such a quote is never executed in one step (`confirmation_required`). Watches' auto trades still pay only with stablecoins. A holding that can't be priced makes the answer unknown (`upstream_unavailable`), not `insufficient_balance`. In owner mode, WPOL or WETH can pay for native POL or ETH.
- `wallet confirm` no longer prints `worstCase`.
- The `polygon-oms-wallet` skill and `setup.md`: how to read buy and sell requests, the wallet address as a message of its own, a plainer connect message, and how to raise the limit with a new code.
