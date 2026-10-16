---
'@polygonlabs/agentconnect-ui': patch
---

MCP client profiles: each connected agent gets a profile from its OAuth client. Muse's profile shows only the tools Muse allows, and `buy` returns a quote that only `confirm_purchase` pays, for the approved total and at most once. Every other agent works as before. Client registration (`/oauth/register`) is capped at 10 a minute per address.
