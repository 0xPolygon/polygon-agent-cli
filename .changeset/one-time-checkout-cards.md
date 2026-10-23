---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': minor
---

Pay at any store, in any country, with a one-time card drawn on the owner's own card. `agent checkout --merchant <store> --total <usd>` (MCP `authorize_checkout`) answers under the auto-pay limit with a card for exactly that total, which pays once and lasts about an hour; over the limit the owner approves first, then `agent checkout --card <id>` (MCP `get_checkout_card`) gets it. The CLI writes the card to a file only the user can read and prints the last four digits. `agent checkout --done <id>` or `--cancel <id>` (MCP `close_checkout`) closes the card. The placeholder-card checkout is gone.
