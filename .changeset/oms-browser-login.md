---
"@polygonlabs/agent-cli": major
---

Wallet login is now Google browser login only. `wallet login` opens a Google sign-in in the browser (OIDC + PKCE) and creates/unlocks the Sequence V3 embedded wallet. Add `--remote` for headless/remote hosts where the browser and CLI are on different machines — it uses a self-hosted OIDC handoff relay (`packages/oidc-relay`, deployed to Cloudflare via GitHub Actions) that only ever carries the OAuth code+state; the PKCE verifier never leaves the CLI.

The funding step is chained after a successful login and is balance-aware: the CLI checks the wallet balance (via the OMS indexer) and routes a funded wallet to a dashboard, an empty one to funding, on a hosted page (`packages/agentconnect-ui`, served at the agentconnect domain; falls back to `wallet.polygon.technology`). On a human's machine (including under Claude Code or another harness) it opens the page in the browser; on a headless/remote host it just returns the URL + wallet address on the CLI. Skip it with `--no-fund`.

BREAKING: the email-OTP login (`wallet login --email` / `--code`) has been removed so there is a single login flow. Sessions and all downstream commands are unchanged, and existing sessions keep working until they expire.
