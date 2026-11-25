# @polygonlabs/oidc-relay

## 0.0.3

### Patch Changes

- [#295](https://github.com/0xPolygon/polygon-agent-cli/pull/295) [`ca9528f`](https://github.com/0xPolygon/polygon-agent-cli/commit/ca9528f42a30ab704ae77850d9bd79e9c2544ace) Thanks [@shan8851](https://github.com/shan8851)! - Reject malformed requests with a clear 400 error

  The sign-in, approval and connector endpoints now validate the shape of every request body up front, so a body of the wrong type gets a plain error naming the problem instead of failing partway through. Valid requests behave exactly as before.

## 0.0.2

### Patch Changes

- [#290](https://github.com/0xPolygon/polygon-agent-cli/pull/290) [`e8eaca6`](https://github.com/0xPolygon/polygon-agent-cli/commit/e8eaca624690783b63487bcb0811625c5a01748b) Thanks [@shan8851](https://github.com/shan8851)! - Update the Workers runtime compatibility date to 2026-03-10 so both Workers pick up current runtime behaviour.

## 0.0.1

### Patch Changes

- 1acbcbd: Sign-in methods: `wallet login` now connects with an allowance and picks the sign-in itself, a browser page or an emailed code.
  - **Session mode by default.** Bare `wallet login` is session mode. The browser method returns `waiting` with a page `url` and a `--wait` next. The chat method returns `email_required` or `code_sent`. `wallet login --owner` is the old owner sign-in (`--local` and `--remote` only work with it).
  - **Waiting.** `wallet login --wait` and `wallet confirm --request <id> --wait` block up to about 90 seconds. `allowance set`, `renew`, `withdraw` and `access` use the same picker and accept `--email`.
  - **Picker.** `POLYGON_AGENT_SIGNIN=browser|email` forces a method. `workspace init --platform <muse|openclaw|hermes|claude-code|cursor|codex|other>` records the assistant platform.
  - **Errors.** New codes `email_required`, `browser_signin_failed`, `request_cancelled` and `request_in_progress`.
  - **Funding.** Outputs may carry `funding: { url, reason?, amountUsd? }` for an empty wallet, `insufficient_balance` and a Polymarket deposit shortfall. The login page shows what the sign-in approves and offers funding after connect.
  - **Polymarket.** Every owner sign-in backs up the Polymarket trading key, and the result shows it as `polymarket`.
  - **Wording.** User-facing text says "agent wallet" instead of "OMS wallet".
