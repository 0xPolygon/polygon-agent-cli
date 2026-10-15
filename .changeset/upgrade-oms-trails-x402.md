---
'@polygonlabs/agent-cli': minor
'@polygonlabs/agentconnect-ui': patch
---

Upgrade `@polygonlabs/oms-wallet` to 0.3.1 (pinned), `@0xtrails/api` and `0xtrails` to 0.18.6, `@x402/*` to 2.28, `viem` to 2.57 and `@0xsequence/network` to 2.3.47.

- Gas-sponsored transactions no longer fail with "Unable to pay gas": oms-wallet 0.3 calls the fee selector with an empty list for them, which now continues with no fee. Paid fees return the SDK's selection, including its index.
- `swap` follows the Trails 0.18 flow: no `commitIntent` (deprecated), the deposit must have a successful on-chain receipt before the quote's intent is executed, and transient `executeIntent` failures are retried. A dry run now only quotes; it no longer commits the intent. Confirmation or execution failures name the intent id and deposit hash for recovery.
- The funding widget uses 0xtrails 0.18's `to.token` (was `to.currency`).
- `slow-redact` is pinned to 0.3.1 (the last version with provenance), pulled in by 0xtrails through WalletConnect's logger.
