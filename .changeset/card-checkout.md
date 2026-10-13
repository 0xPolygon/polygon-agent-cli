---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': minor
---

Buy with the saved card. `agent credentials buy "<what to buy>"` shops at real stores through AgentCard's Purchase API and returns a cart; `--confirm <hash>` places it, shipping to the saved address and paying with the saved card after the owner approves with their passkey. The worker keeps the AgentCard connection for each wallet from its add-a-card session, sealed with the rest of its saved details.
