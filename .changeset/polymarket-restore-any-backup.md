---
'@polygonlabs/agent-cli': patch
---

Polymarket: `setup --broadcast` in owner mode now finds a backed-up trading key under another install name. With no key of its own, it restores the one backed-up key whose account holds pUSD or positions instead of making a new account over it, and asks for `--from <address>` when several do. `--new` keeps the old behavior. Owner sign-in no longer makes a key on a new install while other installs' keys exist, so setup can restore one.
