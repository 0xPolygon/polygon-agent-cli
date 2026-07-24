---
'@polygonlabs/agentconnect-ui': patch
---

Show a get-started screen when the dashboard is opened without a wallet deep link. Instead of "Open this page from the polygon-agent CLI", it now displays the skill install command (`npx skills add https://github.com/0xPolygon/polygon-agent-cli`) and the starter prompt "set up a Polygon Agent for me", each with a copy button.

Also serve the agent skills from this deployment: the build now copies the repo `skills/` tree into `dist/`, so the Cloudflare worker serves `SKILL.md`, `polygon-agent-cli/SKILL.md`, `polygon-defi/SKILL.md`, `polygon-discovery/SKILL.md`, and `polygon-polymarket/SKILL.md` at `agentconnect.polygon.technology` (previously served only by the retired connector-ui). The dashboard's main skill link now points at the canonical `polygon-agent-cli/SKILL.md`.
