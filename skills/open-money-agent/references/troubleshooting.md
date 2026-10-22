# Troubleshooting

**When to use:** a command failed and its `hint` and `command` didn't settle it. Errors specific to a task are in that task's reference ([connect](connect.md), [trade](trade.md), [polymarket](polymarket.md), [earn](earn.md), [paid services](paid-services.md)).

## General

| Issue | Fix |
|-------|-----|
| `Wallet not found` / no wallet yet | `wallet list`, then `agent wallet login` |
| Owner-mode session expired (`OMS_SESSION_EXPIRED`) | Run `agent wallet login --owner` (~1-week lifetime) |
| `Fee option errors` | Set `POLYGON_AGENT_DEBUG_FEE=1`, ensure wallet has POL or a fee token. For native-only wallets, add `--prefer-native-fee` on `call` |
| Wrong recipient in Trails widget | Send `dashboard.url` from `agent wallet status`, or run `agent fund` if the user wants it opened on this machine (do not construct the URL manually) |
| `x402-pay`: no 402 response | Endpoint doesn't require x402 payment, or URL is wrong |
| `x402-pay`: payment token mismatch | Chain/token in the 402 response differs from wallet — check `--wallet` points to the right chain |
| `x402-pay`: EOA funding failed | Wallet lacks sufficient balance to cover the payment amount — run `balances` and fund if needed |

## Version drift

If a command fails with "Unknown argument" or "command not found", this skill and the CLI don't match. For an assistant install, run `"$POLYGON_AGENT" update` (it refreshes the CLI and this skill together). For a global install, see [developer](developer.md).
