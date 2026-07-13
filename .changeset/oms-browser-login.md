---
"@polygonlabs/agent-cli": minor
---

`wallet login` now opens a branded login page (agentconnect-ui) in the browser by default. The user chooses Google or email on the page, and email logins enter their one-time code there too, not in the terminal. This works whether the browser and the CLI are on the same machine or on different ones, so there is no separate remote mode to turn on.

`--local` keeps the previous loopback flow (a raw Google sign-in URL and a localhost callback) for anyone who wants it. `--remote` is now a deprecated no-op, since the default flow already works remotely; it prints a notice and otherwise does nothing.

The relay and login page URLs default to the production deployments and can be overridden with `POLYGON_AGENT_OIDC_RELAY` and `POLYGON_AGENT_LOGIN_UI`.

The funding step is still chained after a successful login and is balance-aware: the CLI checks the wallet balance (via the OMS indexer) and routes a funded wallet to a dashboard, an empty one to funding, on a hosted page (`packages/agentconnect-ui`, served at the agentconnect domain; falls back to `wallet.polygon.technology`). The browser login flow prints the funding panel rather than auto-opening it, since the login page's own success screen already points the user onward; the `--local` path keeps opening it. Skip it with `--no-fund`.

Sessions and all downstream commands are unchanged, and existing sessions keep working until they expire.
