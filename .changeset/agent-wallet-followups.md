---
'@polygonlabs/agent-cli': patch
---

- The product is now called Polygon Agent Wallet. A connected install appears to the wallet owner as "Polygon Agent Wallet (<install name>)", and `setup.md` uses the new name.
- The Polymarket skill says what to do when the platform stops commands before `deposit --broadcast`'s 5-minute wait: allow 6 minutes, or use `--no-wait` and check `status` later.
