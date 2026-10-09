---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': patch
---

Skills for personal assistants: `setup.md` (the one-time install guide: workspace install, Node if needed, the skill, connect by email code, funding) and the `polygon-oms-wallet` skill, which `workspace init` installs pointed at the wrapper. The `polygon-agent-cli` skill gains session mode, prices, watches, alerts and workspace installs; `polygon-discovery` gains `--max-usd`. The skills site also serves `/setup.md` and a skill index at `/.well-known/agent-skills/index.json`, and redeploys when skills change. `wallet status` reports a pending request before the first connect (so it's resumed, not resent); `watch check` returns the schedule to keep (or `null` once nothing needs checking); `workspace init` accepts `~/.polygon-agent` alongside a global install's state.
