---
'@polygonlabs/agent-cli': patch
---

`wallet login --owner` on a session-mode install now revokes the install's session keys the way `wallet logout` does: through each key itself, with the owner sign-in only as a fallback. OMS refused the owner-only revoke, so the switch failed (safely, changing nothing) with "OMS is unavailable (Unauthorized)".
