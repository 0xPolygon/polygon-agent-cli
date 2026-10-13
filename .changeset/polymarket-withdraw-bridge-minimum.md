---
'@polygonlabs/agent-cli': patch
---

`polymarket withdraw` now refuses amounts under Polymarket's $2 bridge minimum (`below_bridge_minimum`) before anything is sent. Below it, the bridge never paid out: the pUSD sat at the bridge address while the CLI reported that USDC would arrive. Trading key recovery and old-key sweeps leave a balance under $2 in the old account (its key stays in OMS) instead of stranding it at the bridge.
