---
"@polygonlabs/agent-cli": minor
---

Migrate the embedded wallet to `@polygonlabs/oms-wallet`, the renamed and updated successor to `@0xsequence/typescript-sdk`. Internally `OMSClient` becomes `OMSWallet`, with the same constructor shape and the same `.wallet` / `.indexer` sub-clients.

**Node 22+ is now required** (was Node 20+). Update your runtime before upgrading.

The Google leg of `wallet login` is re-architected onto the SDK's OMS relay: our own OAuth-capture endpoints are gone, and the OMS relay now handles the Google callback directly and returns the browser to the agentconnect login page to finish pairing with the CLI. This is an internal re-architecture with no user-facing behavior change beyond the Node floor: `wallet login` still opens the same login page, still lets you choose Google or email, and sessions still last about a week.

Email login, transactions, and balances are unchanged.
