---
'@polygonlabs/agentconnect-ui': patch
'@polygonlabs/agent-cli': patch
---

A purchase is paid once: approving it, or confirming a Muse quote, is claimed in a per-wallet Durable Object that only the worker can reach, so two approvals at the same moment can't both pay. The CLI's saved-details site can be set apart from its login page with `POLYGON_AGENT_CREDENTIALS_URL`.
