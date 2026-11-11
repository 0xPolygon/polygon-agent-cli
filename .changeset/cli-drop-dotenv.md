---
'@polygonlabs/agent-cli': patch
---

Remove the unused `dotenv` dependency, so installing the CLI pulls in one package fewer. The CLI never loaded it; nothing about how it reads its environment changes.
