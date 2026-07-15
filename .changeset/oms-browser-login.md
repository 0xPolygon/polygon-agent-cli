---
"@polygonlabs/agent-cli": minor
---

Zero-setup onboarding: `agent wallet login` is now the entire setup.

- **`agent` is the primary command.** The CLI ships as `agent` (with `polygon-agent` kept as a long-form alias), so onboarding is `agent wallet login`.
- **Browser login.** `wallet login` opens a branded login page (agentconnect) where the user chooses Google or email; email one-time codes are entered on the page. It works whether the browser and the CLI are on the same machine or different ones, so there is no separate remote mode. `--local` keeps the previous loopback flow (raw Google URL plus localhost callback); `--remote` is a deprecated no-op.
- **No keys to obtain.** The CLI ships a default OMS publishable key, and a successful login auto-provisions a Sequence Builder project and access key (the indexer and Trails quota) into `~/.polygon-agent/builder.json`. Provisioning is best-effort: a failure never fails the login and retries on the next `wallet login`. Point at your own project with `OMS_PUBLISHABLE_KEY` (renamed from `SEQUENCE_PUBLISHABLE_KEY`) or `setup --oms-publishable-key`.
- **Post-login and funding land on the agentconnect dashboard** (wallet prefilled, same app). The `fund` command and the dashboard's Add funds button open the Trails funding widget directly. Relay and login-page URLs default to the production deployments and can be overridden with `POLYGON_AGENT_OIDC_RELAY` and `POLYGON_AGENT_LOGIN_UI`.

Sessions and all downstream commands are unchanged, and existing sessions keep working until they expire.
