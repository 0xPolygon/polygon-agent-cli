---
'@polygonlabs/agentconnect-ui': minor
'@polygonlabs/agent-cli': patch
---

The MCP server covers the rest of the agent wallet: paid web services (`pay_service`, x402), earn vaults (`earn_vaults`, `earn_deposit`, `earn_withdraw`) and Polymarket (markets, account, deposit, buy, sell, cancel, redeem, withdraw). Earn deposits are paid from the allowance through Trails; withdrawals run from the owner's wallet with the sign-in kept from connecting, so the owner just approves them. Every connection to a wallet shares one Polymarket account. ChatGPT gets the same tools except funding Polymarket and betting, and every spend from ChatGPT waits for the owner's approval on the site (`/approve`, `get_action`). Polymarket follows its region rules for where the owner is.
