# @polygonlabs/agentconnect-ui

## 0.0.1

### Patch Changes

- 8be6b13: Show a get-started screen when the dashboard is opened without a wallet deep link. Instead of "Open this page from the polygon-agent CLI", it now displays the skill install command (`npx skills add https://github.com/0xPolygon/polygon-agent-cli`) and the starter prompt "set up a Polygon Agent for me", each with a copy button.

  Also serve the agent skills from this deployment: the build now copies the repo `skills/` tree into `dist/`, so the Cloudflare worker serves `SKILL.md`, `polygon-agent-cli/SKILL.md`, `polygon-defi/SKILL.md`, `polygon-discovery/SKILL.md`, and `polygon-polymarket/SKILL.md` at `agentconnect.polygon.technology` (previously served only by the retired connector-ui). The dashboard's main skill link now points at the canonical `polygon-agent-cli/SKILL.md`.

- c43a308: Serve the canonical skill at the legacy root URL. The build now aliases `polygon-agent-cli/SKILL.md` to `/SKILL.md` in the deployed assets, so `https://agentconnect.polygon.technology/SKILL.md` returns the skill markdown (200) instead of falling back to the SPA `index.html`. Deploy-only copy; the repo `skills/` tree is unchanged, so `npx skills add` still lists one canonical skill.
