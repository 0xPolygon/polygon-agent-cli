---
'@polygonlabs/agent-cli': minor
---

Trading and x402 in session mode.

- `swap` is built on a shared, resumable trade core (`lib/trade/`). A dry run saves the quote; `swap --intent <id> --broadcast` executes exactly that quote, and `swap status --intent <id>` resumes or reports a trade. A deposit is never sent twice: an interrupted trade picks up from its saved state and, in session mode, from the transfer engine's records.
- Every quote is checked before anything is sent: the deposit must be exactly a transfer of the quoted amount of the source token to the intent's deposit address, owned by and delivering to the wallet (`upstream_invalid_quote` otherwise).
- `--from` is optional (a covered stablecoin with enough balance and allowance: USDC on Polygon first); `--amount` takes a number, `<n>%` or `all`; `--amount-usd` sells a USD amount at the current price. In session mode buys of ETH, POL or BTC deliver the chain's covered WETH, WPOL or WBTC/cbBTC, and uncovered tokens return `not_covered`.
- Slippage is capped by `max_slippage` in config.json (default 1%); fees over 10% of the trade add a warning.
- `x402-pay` gains `--max-usd` and `--yes`. Payments over `x402_max_per_call` ($1) need `--yes` (`confirmation_required`), and `x402_daily_max` ($10 over 24 hours) caps the total (`daily_limit_exceeded`), on both payment paths. A service that fails after payment is reported plainly with what was paid.
- Session-mode installs get their own Builder access key (Trails quotes need one) and x402 signer after connecting, or on first use: the same zero-step provisioning as browser login.
- New error codes: `quote_expired`, `upstream_invalid_quote`, `trade_failed`, `confirmation_required`, `x402_price_exceeds_max`, `daily_limit_exceeded`.
