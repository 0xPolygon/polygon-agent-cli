# OMS Wallet SDK Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Migrate the CLI from `@0xsequence/typescript-sdk@0.1.0-alpha.4` to `@polygonlabs/oms-wallet@0.2.0`, re-architecting the Google OIDC leg onto the SDK's OMS relay and simplifying our relay worker.

**Architecture:** Mechanical rename swap for email/tx/indexer/errors/networks; a re-architected Google leg where the OMS relay owns the OAuth callback and returns the browser to an `omsRelayReturnUri` (the agentconnect `/login` page), which posts the callback URL back to the CLI over the existing `LoginSession` pairing channel; the CLI calls `completeOidcRedirectAuth({ callbackUrl })`. Our custom `OidcHandoff` DO and `/api/oidc/*` routes are deleted. Spec: `docs/superpowers/specs/2026-07-16-oms-wallet-sdk-migration-design.md`.

**Tech Stack:** TypeScript, `@polygonlabs/oms-wallet@0.2.0` (viem ^2.48.4, Node 22+), Cloudflare Workers + Durable Objects, React 18 + Vite, vitest.

## Global Constraints

- Conventional commit messages, lowercase subject (commitlint `subject-case`: no Sentence/Title/UPPER case in the subject); package scope; never a Co-Authored-By trailer.
- Pre-commit hook runs `pnpm -r run typecheck` across all packages; lint-staged may reformat.
- No em dashes in any copy or comments; sentence case.
- Canonical skill docs live in the repo-root `skills/` tree only.
- `LoginAction`/`LoginStatus` shapes are duplicated verbatim across `packages/oidc-relay/src/login-session.ts`, `packages/polygon-agent-cli/src/lib/browser-login.ts`, and `packages/agentconnect-ui/src/login/machine.ts`; keep them in sync.
- New pinned dep: `@polygonlabs/oms-wallet@0.2.0`. Remove `@0xsequence/typescript-sdk`. Ensure CLI `viem` satisfies the SDK's `^2.48.4` (bump the CLI's `viem ^2.45.3` to `^2.48.4`).
- Do not adopt new SDK features beyond what the current code used (no signInWithOidcIdToken, callContract, BYO providers).

## Symbol reference (used across tasks)

New import module `@polygonlabs/oms-wallet`. Renames: `OMSClient`→`OMSWallet`, `isOmsSdkError`→`isOMSWalletError`. Unchanged names: `EthereumPrivateKeyCredentialSigner`, `findNetworkById`, `StorageManager`, `FeeOptionWithBalance`, `TransactionMode`, `TokenBalance`. OIDC: `OmsRelayOidcProviders` (`.google`), `StartOidcRedirectAuthParams` (`{ provider, omsRelayReturnUri? }`), `StartOidcRedirectAuthResult` (`{ authorizationUrl }`), `CompleteOidcRedirectAuthParams` (`{ callbackUrl?, walletSelection? }`).

New `LoginAction` variant (all three copies): `{ type: 'oidc-callback'; callbackUrl: string }`.

---

### Task 1: Dependency swap and mechanical renames (non-OIDC)

**Files:**
- Modify: `packages/polygon-agent-cli/package.json` (deps, engines), root `.nvmrc` if needed, root `package.json` engines
- Modify: `packages/polygon-agent-cli/src/lib/oms-storage.ts`, `oms-tx.ts`, `indexer.ts`, `src/commands/operations.ts`, `src/commands/operations-ui.tsx`
- Modify: `packages/polygon-agent-cli/src/lib/oms-client.ts` (OMSClient→OMSWallet only; OIDC helper removal is Task 3)

**Interfaces:**
- Produces: `getOmsClient()` returns an `OMSWallet`; all non-OIDC imports resolve from `@polygonlabs/oms-wallet`. Later tasks build on this compiling.

- [ ] **Step 1: Swap the dependency**

In `packages/polygon-agent-cli/package.json`: remove `"@0xsequence/typescript-sdk": "0.1.0-alpha.4"`, add `"@polygonlabs/oms-wallet": "0.2.0"`, bump `"viem"` to `"^2.48.4"`, and set `"engines": { "node": ">=22" }` (add the field if absent). Then run `pnpm install` and confirm the lockfile updates with no peer errors.

- [ ] **Step 2: Rename imports in the mechanical sites**

In each of `oms-storage.ts`, `oms-tx.ts`, `indexer.ts`, `operations.ts`, `operations-ui.tsx`: change the import specifier `@0xsequence/typescript-sdk` → `@polygonlabs/oms-wallet`. In `oms-tx.ts` also rename `isOmsSdkError` → `isOMSWalletError` at its import and call sites. In `oms-client.ts` change the import and `OMSClient` → `OMSWallet` in the import and the `new OMSClient(...)` construction (leave `oidcRelayRedirectUri` for Task 3).

- [ ] **Step 3: Node version wording**

`.nvmrc` is already Node 24 (dev); no change needed there. Update root `package.json` `engines.node` to `>=22` if it pins lower. (Doc wording updates land in Task 7.)

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @polygonlabs/agent-cli typecheck`
Expected: the OIDC code in `wallet.ts`/`browser-login.ts` will still reference old shapes and MAY error; if so, this task's commit is allowed to leave those two files failing ONLY IF they are untouched here (they are). To keep the commit green, run typecheck and if `wallet.ts`/`browser-login.ts` are the only errors and they are about `startOidcRedirectAuth`/`state`, that is expected and fixed in Task 3-4. Prefer: land Task 1 + 3 + 4 before the pre-commit hook runs a full typecheck. Since the hook blocks a red commit, commit Tasks 1, 3, and 4 together if needed (the controller may merge these steps). Otherwise, if typecheck is green, commit:

```bash
git add packages/polygon-agent-cli/package.json package.json pnpm-lock.yaml packages/polygon-agent-cli/src/lib/oms-storage.ts packages/polygon-agent-cli/src/lib/oms-tx.ts packages/polygon-agent-cli/src/lib/indexer.ts packages/polygon-agent-cli/src/commands/operations.ts packages/polygon-agent-cli/src/commands/operations-ui.tsx packages/polygon-agent-cli/src/lib/oms-client.ts
git commit -m "chore(cli): swap to @polygonlabs/oms-wallet and rename mechanical imports"
```

Note to controller: because the pre-commit hook runs a repo-wide typecheck, Tasks 1, 3, and 4 likely must be implemented and committed as one unit (the SDK swap makes the old OIDC calls in wallet.ts/browser-login.ts fail to typecheck until they are reworked). Dispatch them together, or have the implementer stage all three tasks' files and make one commit. Task 2 (relay), Task 5 (UI), Task 6 (docs/tests) are independently committable.

---

### Task 2: Simplify the relay worker (delete OidcHandoff, add oidc-callback action)

**Files:**
- Modify: `packages/oidc-relay/src/relay.ts` (remove OidcHandoff DO + `/api/oidc/*` routes; keep `/api/login/*`)
- Delete: `packages/oidc-relay/src/return-to.ts`, `packages/oidc-relay/src/return-to.test.ts`
- Modify: `packages/oidc-relay/src/login-session.ts` (`LoginAction` gains `oidc-callback`; `validAction` in relay.ts accepts it)
- Modify: `packages/oidc-relay/wrangler.toml` (drop OidcHandoff binding; add `deleted_classes` migration, all envs)

**Interfaces:**
- Consumes: nothing new.
- Produces: relay serves only `/api/login/*`; `LoginAction` includes `{ type: 'oidc-callback'; callbackUrl: string }`. Tasks 3 and 5 rely on this action shape.

- [ ] **Step 1: Extend the action type and validator**

In `login-session.ts`, add to `LoginAction`: `| { type: 'oidc-callback'; callbackUrl: string }`. In `relay.ts` `validAction`, accept `type === 'oidc-callback'` when `callbackUrl` is a string, 1..2048 chars, starting `https://` or `http://localhost` / `http://127.0.0.1`.

- [ ] **Step 2: Remove the OidcHandoff DO and /api/oidc routes**

Delete the `OidcHandoff` class, the `DONE_HTML`/`FAIL_HTML`/`CLOSE_HTML` constants, the `validState`/`validReturnTo` usage tied to it, the `import { validReturnTo }`, and the three `/api/oidc/register|cb|poll` route blocks. Remove `OIDC_RELAY` from the `Env` interface and its `export { OidcHandoff }`. Keep everything under `/api/login/*` and the `LoginSession` export. Delete `return-to.ts` and `return-to.test.ts`.

- [ ] **Step 3: wrangler.toml migration**

Remove the `OIDC_RELAY` durable-object binding blocks (top-level, staging, production). Add a new migration tag (e.g. `v3`) with `deleted_classes = ["OidcHandoff"]` to each env's migration list. Keep the `LOGIN_SESSION` binding.

- [ ] **Step 4: Verify and commit**

Run: `pnpm --filter @polygonlabs/oidc-relay typecheck && pnpm --filter @polygonlabs/oidc-relay test`
Then a `wrangler dev` smoke on `/api/login/register` + `/api/login/action` with an `oidc-callback` action (expect 204) and confirm `/api/oidc/cb` now 404s. Commit:

```bash
git add packages/oidc-relay/src/relay.ts packages/oidc-relay/src/login-session.ts packages/oidc-relay/wrangler.toml
git rm packages/oidc-relay/src/return-to.ts packages/oidc-relay/src/return-to.test.ts
git commit -m "refactor(oidc-relay): drop oidchandoff, keep login pairing, add oidc-callback action"
```

---

### Task 3: CLI OIDC client rework (oms-client + oidc-relay-client)

**Files:**
- Modify: `packages/polygon-agent-cli/src/lib/oms-client.ts` (remove `oidcRelayRedirectUri`; keep relay/login base URL helpers)
- Modify: `packages/polygon-agent-cli/src/lib/oidc-relay-client.ts` (remove `registerRelaySession`/`pollRelayForCallback`; keep nothing OIDC-specific, or delete the file if now empty)
- Modify: `packages/polygon-agent-cli/src/lib/login-relay-client.ts` (drop `registerOidcHandoff`/`pollOidcCallback` from the relay dep; the callback now arrives as an `oidc-callback` action)

**Interfaces:**
- Consumes: `LoginAction` with `oidc-callback` (Task 2).
- Produces: `BrowserLoginDeps['relay']` no longer has `registerOidcHandoff`/`pollOidcCallback`; `makeLoginRelay` returns only `registerSession`/`nextAction`/`setStatus`. Task 4 uses the trimmed shape.

- [ ] **Step 1: oms-client.ts**

Remove `oidcRelayRedirectUri()` and the `SEQUENCE_OIDC_RELAY_URI` reference (no `relayRedirectUri` in the new SDK). Keep `oidcRelayBaseUrl()` and `loginUiBaseUrl()` (still used for the pairing relay and the login page). `getOmsClient` already returns `OMSWallet` after Task 1.

- [ ] **Step 2: Trim the relay clients**

In `oidc-relay-client.ts`, remove `registerRelaySession` and `pollRelayForCallback`. If the file has no remaining exports, delete it and drop its imports. In `login-relay-client.ts`, remove `registerOidcHandoff` and `pollOidcCallback` from the returned object and the `import` of the deleted functions; keep `registerSession`, `nextAction`, `setStatus`.

- [ ] **Step 3: Verify (compiles with Task 4)**

Typecheck will fail until Task 4 rewrites the consumers in `browser-login.ts`/`wallet.ts`; implement Task 4 before committing (see Task 1 controller note). No standalone commit.

---

### Task 4: CLI browser-login loop and wallet login rework

**Files:**
- Modify: `packages/polygon-agent-cli/src/lib/browser-login.ts` (google branch + deps shape)
- Modify: `packages/polygon-agent-cli/src/lib/browser-login.test.ts`
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts` (handleLogin google + `--local`)

**Interfaces:**
- Consumes: trimmed relay deps (Task 3); `OmsRelayOidcProviders`, new `startOidcRedirectAuth`/`completeOidcRedirectAuth` signatures.
- Produces: the migrated login flow.

- [ ] **Step 1: Rework `runBrowserLogin`'s wallet dep and google branch**

Update `BrowserLoginDeps['wallet']` OIDC methods to the new shapes: `startOidcRedirectAuth(p: { provider: unknown; omsRelayReturnUri: string }): Promise<{ authorizationUrl: string }>` and `completeOidcRedirectAuth(p: { callbackUrl: string; walletSelection: 'automatic' }): Promise<{ walletAddress: string }>`. Add `oidcProviderGoogle` to deps (the `OmsRelayOidcProviders.google` value, injected so tests can fake it). Remove `registerOidcHandoff`/`pollOidcCallback` from `BrowserLoginDeps['relay']`.

Rewrite the google branch: on the `google` action, call `startOidcRedirectAuth({ provider: deps.oidcProviderGoogle, omsRelayReturnUri: <pageUrl carrying session> })`, publish `{ status: 'auth-url', url: authorizationUrl }`, then continue the action loop waiting for an `oidc-callback` action; on receiving it, call `completeOidcRedirectAuth({ callbackUrl, walletSelection: 'automatic' })`, publish `done`, return `{ walletAddress, loginMethod: 'google' }`. Keep the single error funnel and timeout. The `omsRelayReturnUri` is `${opts.uiBase}/login?s=${session}` (session in a query param so it survives the relay round-trip; the page reads `s`).

- [ ] **Step 2: Update tests**

Rewrite the google-flow tests in `browser-login.test.ts` to the new sequence (action `google` → status `auth-url` → action `{type:'oidc-callback', callbackUrl}` → `completeOidcRedirectAuth` → status `done`), with a fake `oidcProviderGoogle` sentinel and a fake wallet whose `startOidcRedirectAuth` returns `{ authorizationUrl }`. Keep email, cancel, timeout, relay-failure tests (email path unchanged). Add a test that a provider-start failure funnels an error status.

- [ ] **Step 3: wallet.ts handleLogin**

In the browser branch, build deps with `oidcProviderGoogle: OmsRelayOidcProviders.google` (import from `@polygonlabs/oms-wallet`) and the trimmed relay. Remove `seqRelay`/`oidcRelayRedirectUri`. For `--local`: set `omsRelayReturnUri` to the loopback server URL, open `authorizationUrl`, capture the returned URL at the loopback server, and call `completeOidcRedirectAuth({ callbackUrl, walletSelection: 'automatic' })`. If the loopback rework is blocked by relay return-URI constraints, make `--local` print that Google-over-local is unavailable and to use the default flow, and keep `--local` for nothing else (decide in Task 8 e2e). Keep the already-logged-in short-circuit and Builder provisioning.

- [ ] **Step 4: Verify and commit (with Tasks 1 and 3)**

Run: `pnpm --filter @polygonlabs/agent-cli test && pnpm -r run typecheck`
Commit Tasks 1, 3, 4 together (see Task 1 note):

```bash
git add packages/polygon-agent-cli
git commit -m "feat(cli): migrate google login to the oms-wallet relay redirect flow"
```

---

### Task 5: agentconnect-ui login page rework

**Files:**
- Modify: `packages/agentconnect-ui/src/login/machine.ts`, `machine.test.ts`
- Modify: `packages/agentconnect-ui/src/login/LoginPage.tsx`

**Interfaces:**
- Consumes: the pairing `/api/login` routes and the `oidc-callback` action.
- Produces: the page that redirects to `authorizationUrl` and, on return from the OMS relay, posts the callback URL back.

- [ ] **Step 1: machine.ts**

Add `LoginAction` `oidc-callback` to the UI copy for type parity. The status/state machine is mostly unchanged (`auth-url` still triggers the redirect side effect; `done`/`error`/`expired` terminal). Add a state or flag for "returned from relay, posting callback" if helpful (e.g. reuse `auth-pending`). Update tests for any new transition.

- [ ] **Step 2: LoginPage.tsx**

Read the session id from `?s=` (query) first, falling back to the `#` fragment for backward compatibility. On initial load, detect whether the URL carries the OMS relay callback params (the page was returned to from the relay). If so, POST `{ type: 'oidc-callback', callbackUrl: window.location.href }` to `/api/login/action` for this session, and show the "finishing sign in" state. Otherwise render the method chooser as today. Keep the `google-wait` → redirect-to-`authorizationUrl` side effect (the `auth-url` status carries the URL). Keep email/OTP unchanged. Keep the success auto-redirect to the dashboard.

- [ ] **Step 3: Verify and commit**

Run: `pnpm --filter @polygonlabs/agentconnect-ui typecheck && pnpm --filter @polygonlabs/agentconnect-ui lint && pnpm --filter @polygonlabs/agentconnect-ui test`
Commit:

```bash
git add packages/agentconnect-ui/src/login
git commit -m "feat(agentconnect-ui): post oms relay callback back over the login pairing channel"
```

---

### Task 6: Docs, changeset, and Node-version wording

**Files:**
- Modify: `CLAUDE.md`, `packages/polygon-agent-cli/README.md`, `skills/SKILL.md`, `skills/polygon-agent-cli/SKILL.md`
- Modify/Create: `.changeset/*.md`

**Interfaces:** none.

- [ ] **Step 1: Docs**

Update any "Node 20+" to "Node 22+". Update the wallet-auth description if it mentions `SEQUENCE_OIDC_RELAY_URI` or our `/api/oidc/cb` capture (now the OMS relay handles the Google callback). Do not rename the storage dir or env vars unrelated to this change.

- [ ] **Step 2: Changeset**

Add `.changeset/oms-wallet-sdk.md` (`"@polygonlabs/agent-cli": minor`): migrates the embedded wallet to `@polygonlabs/oms-wallet`, requires Node 22+, and re-architects the Google login onto the OMS relay (no behavior change for users beyond the Node floor). Lowercase-subject-safe body; no em dashes.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md packages/polygon-agent-cli/README.md skills/SKILL.md skills/polygon-agent-cli/SKILL.md .changeset
git commit -m "docs: note oms-wallet migration and node 22 requirement"
```

---

### Task 7: Build, unit-verify, and live e2e

**Files:** none (verification; fixes get their own commits).

- [ ] **Step 1: Full build + unit**

`pnpm -r run typecheck`, `pnpm -r --if-present run test`, `pnpm --filter @polygonlabs/agent-cli run build`. All green.

- [ ] **Step 2: Deploy the relay + UI to staging**

Deploy `oidc-relay` staging (confirm the `deleted_classes` migration applies cleanly and `/api/login` still serves; `/api/oidc/cb` 404s) and agentconnect-ui staging (with the new LoginPage). Note: the OMS relay must allow the `omsRelayReturnUri` (`agentconnect.staging.polygon.technology/login`); confirm with the embedded-wallet team that the return URI is allowlisted, since the target changed from `/api/oidc/cb`.

- [ ] **Step 3: Live e2e (human in the loop)**

From a clean HOME, `agent wallet login`: real Google login through the OMS relay leg, confirm the page returns and posts the callback, the CLI completes and reports `builderProvisioned` and a wallet address; email login (regression); a `--local` attempt (record whether Google-over-local works or is disabled). Then `agent balances` and `agent deposit --asset USDC --amount 0.1` dry-run to confirm indexer + Trails via the migrated SDK. Resolve the session-carry / callback-param known unknown here; if `?s=` does not survive, switch to a path-encoded session and re-verify.

- [ ] **Step 4: Whole-branch review, then re-cut the release**

Run the final whole-branch review. Once green, re-cut the held release (PR #126 equivalent) on top of this branch so production ships on the new SDK, and update the production checklist (allowlist target is now the `omsRelayReturnUri`, not `/api/oidc/cb`).
