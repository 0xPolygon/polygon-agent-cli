---
'@polygonlabs/agent-cli': minor
---

Prices, watches and alerts: `price <token>` (USD price from Trails, canonical chain per symbol, stale after 5 minutes); `watch create|list|cancel|check|run` (alert or automatic trades at price levels, once per crossing, re-armed after a 2% move back); `alerts [--ack]`; `wallet status` reports watch alerts and whether checks are running. Session buys without `--to-chain` now pay from a chain where the token bought is covered.
