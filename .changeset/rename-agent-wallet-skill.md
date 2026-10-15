---
'@polygonlabs/agent-cli': patch
'@polygonlabs/agentconnect-ui': patch
---

The assistant skill is now `polygon-agent-wallet` (was `polygon-oms-wallet`). `workspace init`, `update` and `skills install` install it under the new name and remove the old copy, so the assistant doesn't load both. `skills show polygon-oms-wallet` still works, and agentconnect still serves `/polygon-oms-wallet/SKILL.md` for older setup guides.
