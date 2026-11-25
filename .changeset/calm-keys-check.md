---
'@polygonlabs/agentconnect-ui': patch
---

Validate the site's build-time settings once at startup, so a malformed indexer or relay URL now fails with a clear error instead of being used as-is.
