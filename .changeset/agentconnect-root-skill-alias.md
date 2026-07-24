---
'@polygonlabs/agentconnect-ui': patch
---

Serve the canonical skill at the legacy root URL. The build now aliases `polygon-agent-cli/SKILL.md` to `/SKILL.md` in the deployed assets, so `https://agentconnect.polygon.technology/SKILL.md` returns the skill markdown (200) instead of falling back to the SPA `index.html`. Deploy-only copy; the repo `skills/` tree is unchanged, so `npx skills add` still lists one canonical skill.
