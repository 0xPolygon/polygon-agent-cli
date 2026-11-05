---
'@polygonlabs/agent-cli': patch
---

`polymarket markets` now includes each market's `slug`, so agents can pass a readable name to `book`, `buy` and other commands instead of copying the condition id.
