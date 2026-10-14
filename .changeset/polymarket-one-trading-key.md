---
'@polygonlabs/agent-cli': minor
---

Polymarket: one trading key per user, found automatically on every sign-in.

- New keys are backed up under one shared label, `polymarket-trading-key:agent`, so a user's account follows them to every install. Older per-install keys are still found. A lost key is never replaced any more, so keys stop piling up.
- Every sign-in looks for the user's account. Signed in as the owner, it restores the account and signs through OMS. A session-mode install can't sign as that key, so it makes no second account: it returns `existingAccount` with a plain message ("You already have a Polymarket account with $4.20 and 2 open positions. Sign in once more to use it here.") and a command. `setup` and trading fail with the new `sign_in_required` code the same way, and `status` shows it.
- `wallet login --owner` on a session-mode install now starts one more sign-in by the same method the install already uses (emailed code or login page). Once confirmed, the install keeps that sign-in for a week, its session keys are revoked, and it can use the account.
- `polymarket buy` over the balance fails at once with the balance and shortfall, suggesting a smaller bid or a deposit of the shortfall (at least $2), or says a deposit is still being credited.
