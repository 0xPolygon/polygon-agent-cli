# Migration guide

Changes that need action when upgrading `@polygonlabs/agent-cli`, newest first. Versions not listed
need none. `CHANGELOG.md` has the full history.

## 0.17.3

- `setup` no longer includes the generated key in its JSON output. The key is still stored
  locally; scripts that read it from the output need to stop.

## 0.17.0

- AgentPay is now Open Money Agent. Plugin installs under the old `agentpay` name need a reinstall
  as `open-money-agent`. `workspace init` and `update` switch the installed skill for you, and
  `skills show agentpay` still works.

## 0.15.0

- `polymarket import-key` and its `set-key` alias are removed. Use `polymarket setup`, which
  creates and manages the trading key.
- `polymarket positions` rows are snake_case (`current_size`, `avg_price`, `current_price`,
  `unrealized_pnl`, `redeemable`).
- `polymarket markets` pages with `--cursor <nextCursor>`. `--offset` fails with
  `code: offset_removed`.
- `polymarket approve`: wallets approved with an older version should run it once more.
  `--neg-risk` is accepted but no longer needed.
- `wallet confirm` no longer prints `worstCase`.
- The assistant skill `polygon-oms-wallet` is now `polygon-agent-wallet`. `workspace init`,
  `update` and `skills install` replace the old copy.
- Session-mode sign-in defaults to an emailed code, and the CLI no longer opens the funding page
  after a connect. Run `agent fund` to open it.

## 0.13.0

- The `agent agent *` command group is removed. Use the top-level `register`, `identity` (replaces
  `agent agent wallet` and `agent agent metadata`), `reputation`, `reviews` and `feedback`. The
  hidden aliases `agent-wallet`, `agent-metadata`, `give-feedback` and `read-feedback` are removed
  too.

## 0.12.0

- The environment variable `SEQUENCE_PUBLISHABLE_KEY` is renamed to `OMS_PUBLISHABLE_KEY`.
- `wallet login --remote` is deprecated and does nothing: the default login works whether or not
  the browser is on the same machine.
