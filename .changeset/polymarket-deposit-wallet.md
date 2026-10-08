---
"@polygonlabs/agent-cli": minor
---

Polymarket trading through a CLI-managed Polymarket Deposit Wallet.

- `polymarket setup` creates a trading key, deploys a Deposit Wallet and sets approvals through Polymarket's relayer, with no key import and no POL needed.
- `deposit` and `withdraw` move money between the OMS wallet and Polymarket through Polymarket's bridge. Deposits are plain USDC transfers, so they work in session mode and count against the allowance.
- New `status`, `event`, `book`, `history`, `buy`, `sell`, `cancel --all`, `redeem`, `activity` and `pnl`. Markets can be named by slug, and outcomes by name, including multi-outcome events.
- `buy --max-price` and `sell --min-price` refuse a worse estimated fill before posting.
- Region checks: blocked regions can't trade, and close-only regions can only sell, cancel, redeem and withdraw.
- `clob-buy`, `proxy-wallet`, `approve` and `set-key` remain as hidden aliases for one release.
- Polymarket commands run on Node 22 and 24. `@polymarket/client` declares Node 24 in `engines`, so `npm install` on Node 22 may print an `EBADENGINE` warning, which is safe to ignore.
