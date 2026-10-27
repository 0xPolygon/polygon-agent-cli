---
'@polygonlabs/agentconnect-ui': patch
---

Polymarket refusals say whose location is the limit. When the owner's location allows trading but Polymarket won't take new predictions from where the service runs, the error and `polymarket_account` say so (`limitedBy: 'server'`) and tell the agent it isn't the owner's account, instead of "not available for this owner". A buy is checked against Polymarket's region rules before the owner is asked to approve it.

A buy on an account that isn't set up or is short of cash names the deposit to make (the bid plus 1% for the bridge, at least $2) and what the agent wallet holds, so the agent can offer the deposit and the buy together. `polymarket_account` shows the wallet's USDC before the account exists.

The owner's location is updated whenever they answer a request on this site, not only when they connect. Argentina is added to Polymarket's close-only countries.
