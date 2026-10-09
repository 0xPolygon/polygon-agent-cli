---
'@polygonlabs/agent-cli': patch
---

Security hardening from a review of this release:
- Wallet names are validated before they become file paths: a name like `../..` could otherwise make `wallet logout` or `wallet remove` delete folders outside the CLI's state. Wallet files with names that no longer pass are skipped when listing.
- Symbols of tokens outside the reviewed table are shown only when short and plain (never their contract's name), and marked `unverified`, so an airdropped token can't carry instructions into `balances`, `wallet status` or alerts.
- A swap quoted and broadcast in one step is refused (`confirmation_required`, with the command to accept it) when fees or price impact take more than 10%.
- x402: authorizations valid for more than 15 minutes aren't funded or signed, redirects aren't followed, and `@file` arguments can't read the CLI's state folders (compared by device and inode).
- Saved trade deposits are re-checked before sending (amount, token and the deposit address checked at quote time), prices dated in the future count as stale, and allowance limits refuse implausible token prices.
- `update` installs the exact version it checked, with install scripts off.
- Ctrl-C during an owner sign-in removes the sign-in key; locks recover from a reused process id; broken key files no longer hang the CLI; the encryption key is created atomically; the state folder is kept owner-only; withdrawals to the zero address or the token contract are refused.
