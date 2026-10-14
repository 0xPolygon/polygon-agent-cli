---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': minor
---

Pay automatically under a limit, and ask over it. The owner sets an auto-pay limit in dashboard Settings ($25 by default). `agent buy` (and the MCP `buy` tool) places a cart at or under it right away with the saved card; over it, the agent gets an approval link, the owner signs in on the approval page to approve or decline, and `agent buy --approval <id> --wait` (MCP `payment_status`) returns their answer. `agent checkout` (MCP `authorize_checkout`) applies the same limit before an agent pays at any store's checkout in its own browser.
