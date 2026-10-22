---
'@polygonlabs/agentconnect-ui': patch
'@polygonlabs/agent-cli': patch
---

Connecting an MCP client works on both sites the worker serves: each request checks its own site's `/mcp` as the OAuth resource, so ChatGPT's sign-in no longer fails depending on which site was served first. A bad authorization request now goes back to the client as an OAuth error instead of failing. The skill points assistants that can't run commands to the MCP server.
