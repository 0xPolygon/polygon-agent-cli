---
"@polygonlabs/agent-cli": minor
---

Add `wallet login-browser`: browser-based wallet login via Google OIDC (PKCE redirect flow) as an alternative to email OTP, with the funding step chained after a successful login. Sessions persist identically to email login, so downstream commands resume unchanged.

Supports both a local loopback callback and a `--remote` path for headless/remote hosts where the browser can't reach localhost, backed by a self-hosted OIDC handoff relay worker (`packages/oidc-relay`, deployed to Cloudflare via GitHub Actions). The relay only ever carries the OAuth code+state; the PKCE verifier never leaves the CLI.
