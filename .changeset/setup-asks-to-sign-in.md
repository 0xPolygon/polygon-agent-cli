---
'@polygonlabs/agent-cli': patch
'@polygonlabs/agentconnect-ui': patch
---

Assistant skills: after the install, and whenever the wallet isn't connected, the assistant asks "Would you like to sign in to your agent wallet now?" and then for the email, instead of stopping on a status report. `setup.md` works better on Hermes: the workspace follows `$HERMES_HOME`, `ROOT` is exported, the install steps allow up to 10 minutes, and watches note that Hermes cron jobs need the gateway running. The `npx skills add` fallback copies instead of symlinking.
