---
'@polygonlabs/agentconnect-ui': patch
---

Unknown `/.well-known` paths answer 404 instead of the site's page, so OAuth clients probing for OpenID metadata move on to the metadata the MCP server does serve.
