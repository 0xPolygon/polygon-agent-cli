---
'@polygonlabs/agent-cli': minor
---

Session mode: connect this install to an OMS wallet with an email code and a spending allowance, enforced on-chain by smart sessions. Owner mode is unchanged.

- **Owner requests (email code, two steps).**
  - `wallet login --email <e> [--allowance] [--days] [--chains]` registers this install's session key, builds the plan and sends a code.
  - `wallet confirm --request <id> --code <code>` signs in, approves one session per chain, verifies the sessions and checks gas sponsorship through the session key, then always revokes the sign-in. Nothing owner-level is stored.
  - The same two steps run `wallet allowance set [--amount] [--add <token@chain>] [--chains]`, `wallet allowance renew [--days]` (a new session key), `wallet withdraw` and `wallet access [--revoke <id>]`.
- **Allowance.**
  - Each covered token on each covered chain gets an on-chain limit worth the whole allowance, in a reviewed table of tokens (USDC, USDT, USDG, WETH, WBTC, cbBTC, WPOL/POL) on Polygon, Base, Ethereum, Arbitrum, Optimism, BNB Chain, Avalanche, Arbitrum Nova and Katana.
  - A local USD ledger caps the total across tokens.
- **Spending.**
  - `runTx` routes session-mode wallets through `lib/session/transfer.ts`, which records each transfer before sending, reconciles uncertain ones, and never resends.
  - `send-token`, `swap` (from covered ERC-20s) and `x402-pay` work within the allowance.
  - Native coins return `native_not_supported`; other contract calls and Polymarket return `owner_required`.
- **Status.** `wallet status` and `wallet allowance` report the sessions (limits, used, remaining, expiry), the USD total, holdings the allowance does or doesn't cover, pending requests, alerts and, in `wallet status`, the latest CLI version.
- `wallet logout` revokes this install's session key.
- **Errors.** New commands return `{ok: false, error, code, hint?, command?}`.
