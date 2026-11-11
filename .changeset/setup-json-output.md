---
'@polygonlabs/agent-cli': patch
---

`setup` no longer includes the generated key in its JSON output; the key is stored locally as before.

The JSON printed when `setup` runs without a terminal now carries the same fields the interactive output shows: the address, access key and project.
