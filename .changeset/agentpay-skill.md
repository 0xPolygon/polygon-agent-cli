---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': patch
---

One skill, AgentPay, the user's own agent for payments on the Open Money Stack (OMS). The six skill files are now `skills/agentpay/`: a short `SKILL.md` index (check the install, then `wallet status` first, then route the request) and a reference per use case under `references/`, loaded only when a task needs it. `workspace init` installs `agentpay` with its references and removes the `polygon-agent-wallet` and `polygon-oms-wallet` folders it wrote before. `skills show <topic>` prints a reference, and the old skill names still work there. The site serves the index at `/setup.md`, `/SKILL.md` and every older skill URL, and the references at `/references/`.
