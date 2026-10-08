---
'@polygonlabs/agent-cli': minor
---

Buying a token amount, paying with other holdings, and assistant skill fixes from Muse QA:

- `swap --to-amount <n>` buys exactly that much of `--to` ("buy 10 POL"), using a Trails exact-output quote. The deposit is the quoted input, so the quote must guarantee the amount asked for, and it's never executed in one step: the user accepts it by its intent (`confirmation_required`). The source is picked with room for fees, and the quote is rechecked against the balance and the allowance left.
- Without `--from`, a buy in USD or by `--to-amount` falls back to another covered token the wallet holds (largest first, never the token bought) when no stablecoin holds enough. Such a quote is never executed in one step (`confirmation_required`). Watches' auto trades still pay only with stablecoins.
- `wallet confirm` no longer prints `worstCase`.
- The `polygon-oms-wallet` skill and `setup.md`: how to read buy and sell requests, the wallet address as a message of its own, a plainer connect message, and how to raise the limit with a new code.
