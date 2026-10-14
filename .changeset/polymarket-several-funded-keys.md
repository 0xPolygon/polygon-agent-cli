---
'@polygonlabs/agent-cli': patch
---

Polymarket: when several older accounts hold money, a session-mode sign-in gives the plain message with totals ("You already have 2 Polymarket accounts with $4.50 in total. Sign in once more to use them here.") instead of a technical error. Signed in, the result has `chooseAccount`: the accounts, a plain question for the user, and the `setup --from` command to run once they pick.
