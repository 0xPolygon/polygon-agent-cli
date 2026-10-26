---
'@polygonlabs/agentconnect-ui': minor
'@polygonlabs/agent-cli': patch
---

The MCP server can move money. Connecting an agent now asks the owner for a spending limit (US dollars over up to 30 days), and the agent gets its own key for it, approved by the owner on each chain the way a CLI install's is. New tools: `get_allowance`, `send`, `swap_quote`, `swap` (swaps and bridges) and `swap_status`. ChatGPT connections are recognised by their redirect and stay read-only, as do Muse's. Disconnecting an agent revokes its key. The skill tells assistants that can't run commands what the MCP server can do.
