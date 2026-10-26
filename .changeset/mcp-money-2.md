---
'@polygonlabs/agentconnect-ui': minor
'@polygonlabs/agent-cli': patch
---

The MCP server covers the rest of the agent wallet: paid web services (`pay_service`, x402), earn vaults (`earn_vaults`, `earn_deposit`, `earn_withdraw`) and Polymarket (markets, account, deposit, buy, sell, cancel, redeem, withdraw). Earn deposits and withdrawals run from the owner's wallet, so they come back as a link the owner approves after signing in. ChatGPT gets the same tools except funding Polymarket and betting, and every spend from ChatGPT waits for the owner's approval on the site (`/approve`, `get_action`). Polymarket follows its region rules for where the owner is.
