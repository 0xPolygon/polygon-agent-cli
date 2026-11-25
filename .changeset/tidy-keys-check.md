---
'@polygonlabs/agent-cli': minor
---

Every command now refuses to start, with an `invalid_env` error naming the variable, when one of the URL environment variables (such as `POLYGON_AGENT_OIDC_RELAY` or `POLYMARKET_GAMMA_URL`) holds something that isn't an http(s) URL

Environment variables set to an empty value now count as unset.
