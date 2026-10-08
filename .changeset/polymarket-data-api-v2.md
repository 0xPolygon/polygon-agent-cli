---
"@polygonlabs/agent-cli": minor
---

Move Polymarket reads to the current APIs before Data API v1 retires on 2026-10-24.

- `polymarket positions` reads Data API v2. Rows are snake_case (`current_size`, `avg_price`, `current_price`, `unrealized_pnl`, `redeemable`). New `--status` (`OPEN`, `REDEEMABLE`, `REDEEMABLE_LOST`, `MERGEABLE`, `CLOSED`), `--limit` and `--cursor` options, and the output includes `nextCursor`.
- `polymarket markets` lists through Gamma's keyset endpoint and searches through `/public-search`. Paging uses `--cursor <nextCursor>`; `--offset` now fails with `code: offset_removed`.
- `polymarket market` looks markets up by condition id directly, including closed ones, and reports `version`, `closed` and `acceptingOrders`.
- Token ids come from `positionIds` for Polymarket V2 markets and `clobTokenIds` for V1 markets. `clob-buy` and `sell` refuse V2 markets (`code: unsupported_market_version`) and markets not accepting orders (`code: market_not_accepting_orders`), including on dry runs.
- `polymarket approve` sets one batch covering the standard, neg-risk and Polymarket V2 exchanges. It no longer approves the deprecated Neg Risk Adapter, and `--neg-risk` is accepted but no longer needed. Wallets approved with an older version should run it once more.
