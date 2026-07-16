# Migrate to @polygonlabs/oms-wallet SDK

Date: 2026-07-16
Status: approved (scoped design agreed in conversation)

## Problem

The CLI depends on `@0xsequence/typescript-sdk@0.1.0-alpha.4` for the embedded wallet. Polygon now ships the same SDK, rebranded and updated, as `@polygonlabs/oms-wallet` (latest 0.2.0). We migrate to it. Most of the surface is a mechanical rename, but the OIDC redirect API was redesigned and intersects the browser-login flow, so that leg is re-architected.

## Package facts

- New package: `@polygonlabs/oms-wallet@0.2.0`, single dependency `viem ^2.48.4`, `engines.node >= 22`.
- Same internal shape as the old SDK; the main class is renamed `OMSClient` → `OMSWallet` with an identical constructor (`{ publishableKey, storage?, redirectAuthStorage?, credentialSigner? }`) and the same `.wallet` (OMSWalletClient) and `.indexer` (OMSWalletIndexerClient) sub-clients.

## Node version bump

The published CLI moves from Node 20+ to **Node 22+**. Update `.nvmrc` (already 24 for dev), the CLI `package.json` `engines.node`, `CLAUDE.md`, and README/skills wording that says "Node 20+".

## Mechanical changes (unchanged behavior)

Swap the dependency and update imports across the six current import sites (`oms-client.ts`, `oms-storage.ts`, `oms-tx.ts`, `indexer.ts`, `operations.ts`, `operations-ui.tsx`):

| Old symbol | New symbol | Notes |
|---|---|---|
| `OMSClient` | `OMSWallet` | same constructor params; `getOmsClient` return type follows |
| `isOmsSdkError` | `isOMSWalletError` | error helper rename (oms-tx.ts) |
| `EthereumPrivateKeyCredentialSigner` | same | |
| `findNetworkById` | same | |
| `StorageManager` (type) | same | our `FileStorageManager` still implements it |
| `FeeOptionWithBalance` (type) | same | |
| `TransactionMode` | same | |
| `TokenBalance` (type) | same | now from the indexer client module, still exported from root |

Unchanged method signatures we rely on, verified against the 0.2.0 types: `wallet.walletAddress`, `wallet.startEmailAuth`, `wallet.completeEmailAuth`, `wallet.signTypedData`, `wallet.sendTransaction`, `wallet.signOut`, `indexer.getBalances`. Email login, transactions, and balances need only the import/rename changes.

## The OIDC redirect re-architecture (Google leg)

The old API `startOidcRedirectAuth({ provider: 'google', redirectUri, relayRedirectUri }) -> { url, state }` is replaced by `startOidcRedirectAuth({ provider: OmsRelayOidcProviders.google, omsRelayReturnUri }) -> { authorizationUrl }`. Gone: our own `redirectUri`, the `state` handle, and `relayRedirectUri`. The OMS relay now owns the Google OAuth callback and returns the browser to a caller-nominated `omsRelayReturnUri`. PKCE/state is held internally in the SDK's `redirectAuthStorage` (our `FileStorageManager`, in the CLI process).

### New flow (CLI holds the SDK; browser is a surface; existing LoginSession pairing reused)

1. CLI calls `startOidcRedirectAuth({ provider: OmsRelayOidcProviders.google, omsRelayReturnUri })` where `omsRelayReturnUri` is the agentconnect `/login` page carrying this pairing session id. Returns `{ authorizationUrl }`; PKCE/state persists in the CLI's redirect store.
2. CLI publishes status `auth-url` (with `authorizationUrl`) to the LoginSession; the page redirects the browser there.
3. Browser completes Google; the OMS relay handles the callback and returns the browser to `omsRelayReturnUri`, appending its callback params.
4. The returned page reads its full URL (`window.location.href`) and posts it back to the CLI as a new pairing action `{ type: 'oidc-callback', callbackUrl }`.
5. CLI receives the action and calls `completeOidcRedirectAuth({ callbackUrl, walletSelection: 'automatic' })` → `{ walletAddress }`, then publishes `done`.

### What this deletes

The OMS relay now performs the OAuth capture our custom relay used to. Remove from `packages/oidc-relay`:
- The `OidcHandoff` Durable Object and the `/api/oidc/register|cb|poll` routes.
- `src/return-to.ts` and its tests (the `returnTo` open-redirect guard existed only for our capture).
- The `OidcHandoff` DO binding in `wrangler.toml`, with a `deleted_classes` migration (all three envs).

Keep the `LoginSession` DO and `/api/login/*` routes. They remain the browser-to-CLI pairing channel, now also carrying the `oidc-callback` action.

Remove from the CLI: `oidcRelayRedirectUri()` / `SEQUENCE_OIDC_RELAY_URI` (no `relayRedirectUri` anymore); `registerRelaySession` / `pollRelayForCallback` in `oidc-relay-client.ts` (state-keyed handoff is obsolete).

### Protocol additions

`LoginAction` (duplicated in relay `login-session.ts`, CLI `browser-login.ts`, UI `machine.ts`) gains `{ type: 'oidc-callback'; callbackUrl: string }`. The relay's `validAction` accepts it with a bounded `callbackUrl` (string, https or http-localhost, ≤ 2048 chars).

### `--local`

The loopback flow can no longer pass a localhost `redirectUri`. Rework it to set `omsRelayReturnUri` to the localhost callback server URL, open `authorizationUrl`, capture the returned URL at the loopback server, and call `completeOidcRedirectAuth({ callbackUrl })`. This still requires the OMS relay to allow a localhost return URI (the same localhost callback was allowlisted previously). If that proves unavailable, `--local` supports email only and prints a clear message; decide during the e2e task.

## Known unknown (resolve with a live e2e, not by guessing)

Whether the OMS relay preserves our session identifier on `omsRelayReturnUri` and how it appends callback params (query vs fragment) is not documented in the package. Default design: carry the session id in the `omsRelayReturnUri` (query param `?s=<session>`, since fragments may be consumed by the relay), have the page read it and post back the full href. The e2e task confirms both the session and the callback params arrive; if the relay rejects dynamic query on the return URI (exact-match allowlist), fall back to encoding the session in the path.

## Testing

- Unit: relay `LoginSession` action validation incl. `oidc-callback`; CLI browser-login loop google path (fakes: action `google` → publish `auth-url` → action `oidc-callback` → `completeOidcRedirectAuth` → `done`); UI machine transitions for the return-from-relay leg; email/tx/indexer suites stay green after the rename.
- Live e2e (staging relay + agentconnect): real Google login (the re-architected leg), email login (regression), and a `--local` attempt; then `balances` and a `deposit` dry-run to confirm indexer + Trails still work through the migrated SDK.

## Deploy / sequencing

- Migration lands on its own branch; the in-flight release PR (#126) is held and will be re-cut on top of this once verified, so production ships on the new SDK.
- Removing the `OidcHandoff` DO needs a `deleted_classes` migration; staging deploy first, confirm the worker deploys and `/api/login` still serves, then production.
- The Sequence/OMS allowlist target shifts from our `/api/oidc/cb` to the `omsRelayReturnUri` (the agentconnect `/login` page). Note this for the production checklist; it changes what the embedded-wallet team allowlists.

## Out of scope

- Adopting the new SDK's `signInWithOidcIdToken`, `callContract`, `revokeAccess`, or custom (BYO) OIDC providers.
- The Google consent-screen rebrand (separate Google Cloud + Sequence config task).
- Rewriting transaction/indexer logic beyond the import/rename swap.
