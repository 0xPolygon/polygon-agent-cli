---
'@polygonlabs/agentconnect-ui': patch
---

Production deploys no longer fail on the long-deleted SessionRelay Durable Object: the production environment has an explicitly empty migrations list, as staging does.
