---
"@polygonlabs/agent-cli": minor
---

Add `wallet login-browser`: browser-based wallet login via Google OIDC (PKCE redirect flow) as an alternative to email OTP, with the funding step chained after a successful login. Sessions persist identically to email login, so downstream commands resume unchanged.

Also adds a self-hosted OIDC handoff relay worker (`packages/oidc-relay`) that will let the CLI complete browser login from a remote machine where a localhost callback can't be reached. The CLI `--remote` path that consumes it lands in a follow-up, once the relay's callback URL is allowlisted upstream.
