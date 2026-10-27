---
'@polygonlabs/agentconnect-ui': patch
---

Earn deposits, Polymarket deposits and Polymarket predictions check the wallet before the owner is asked to approve them, like sends: a wallet that can't cover it gets an answer at once instead of an approval link that fails. Whenever the wallet is short, the agent is told to ask the user to add funds from their dashboard.

Approving a spend answers at once: it runs in the background (a Durable Object alarm) and the approval page follows it to the result. The agent no longer needs another prompt: `get_action` waits up to about 45 seconds for the owner's answer and the result, and agents are told to call it right after showing the link and again while it's pending, so they carry on as soon as the owner approves, or tell the user if it failed.
