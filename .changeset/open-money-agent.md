---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': patch
---

AgentPay is now Open Money Agent. The skill is `skills/open-money-agent/` and the plugin is `open-money-agent` in Claude Code, Codex and Cursor (existing `agentpay` plugin installs need a reinstall under the new name). `workspace init` and `update` install `open-money-agent` and remove the `agentpay` folder they wrote before; `skills show agentpay` still works. The site keeps serving `/agentpay/SKILL.md` and `/agentpay/references/`.
