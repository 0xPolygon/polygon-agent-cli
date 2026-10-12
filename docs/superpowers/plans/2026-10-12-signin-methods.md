# Sign-in methods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session-mode connect and every owner request sign in through the browser (no copy-paste) or a chat code, picked automatically. Every sign-in creates the Polymarket trading key, funding is offered when it matters, and user-facing text says "agent wallet".

**Architecture:** Owner requests gain a `method`. The browser method reuses `runBrowserLogin` with the throwaway owner key, run by a detached waiter process that writes its result to an encrypted file. `wallet login --wait` reads that file. A pure picker chooses the method from the env and the install record.

**Tech Stack:** TypeScript, yargs, vitest, `@polygonlabs/oms-wallet` 0.3.1, Cloudflare Worker (oidc-relay), React (agentconnect-ui).

**Spec:** `docs/superpowers/specs/2026-10-12-signin-methods-design.md` (read it before any task).

## Global Constraints

- Node 22+ for the published CLI. Run tests with `pnpm -C packages/polygon-agent-cli exec vitest run <path>`.
- Stage files by explicit path only. Never `git add -A`, `git add .` or `git commit -a`: untracked secret files exist in this repo.
- Commit subjects are conventional and lowercase (commitlint enforces subject-case). Keep the body lines under 100 characters. Don't add a Co-Authored-By trailer.
- Command tests that could write must pass `--dry-run`, because the persisted mode may be `auto`.
- User-facing copy: no em dashes, sentence case, and "agent wallet" (never "OMS wallet"). "OMS account" and "OMS session key" are fine.
- A Polymarket step never fails the sign-in it rides on.
- The relay `context` and the page changes must stay optional both ways (old CLI with new relay, new CLI with old relay).
- `src/lib/workspace.test.ts` has one known macOS-only failure (a `/private` path); ignore it.

## Review Focus

1. A browser request whose user never opens the page: the waiter exits at `expiresAt`, writes an `ok:false` result, and leaves no pending file or owner key behind.
2. A second `wallet login` while a waiter is running: the old waiter is stopped and its pending file replaced, with no double connect.
3. The user signs in with a Google account that isn't this install's wallet (reconnect): the same wrong-account error as the email path, and the sign-in is still revoked.
4. A pending file from the old CLI (no `method`) still confirms with a code.
5. Headless Linux without `DISPLAY` picks email, and `email_required` names the next command.

---

### Task 1: Sign-in method picker and install platform

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/signin-method.ts`, `packages/polygon-agent-cli/src/lib/signin-method.test.ts`
- Modify: `packages/polygon-agent-cli/src/lib/workspace.ts` (InstallRecord gains optional `platform`), `packages/polygon-agent-cli/src/commands/workspace.ts` (`init --platform`), `packages/polygon-agent-cli/src/commands/workspace.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SignInMethod = 'browser' | 'email';
  export const PLATFORMS = ['muse','openclaw','hermes','claude-code','cursor','codex','other'] as const;
  export type Platform = typeof PLATFORMS[number];
  export interface PickInput { env: NodeJS.ProcessEnv; platform?: Platform; os: NodeJS.Platform; dockerenv: boolean }
  export function pickSignInMethod(input: PickInput): { method: SignInMethod; reason: string };
  export function currentSignInMethod(): { method: SignInMethod; reason: string }; // reads process.env, install record platform, process.platform, fs.existsSync('/.dockerenv')
  ```

- [ ] Write table tests for `pickSignInMethod` in this precedence order:
  - `POLYGON_AGENT_SIGNIN` set to `browser` or `email` wins over everything (invalid values are ignored).
  - platform `muse`, `openclaw` or `hermes` gives email (`reason: 'platform <p>'`).
  - `CI` gives email (`'ci'`), and so do `SSH_CONNECTION`/`SSH_TTY` (`'ssh session'`) and dockerenv (`'container'`).
  - linux with no `DISPLAY` and no `WAYLAND_DISPLAY` gives email (`'no display'`).
  - darwin, win32, or linux with a display gives browser (`'desktop'`).
- [ ] Implement it, and make the tests pass.
- [ ] `workspace init --platform <p>` (choices from `PLATFORMS`) stores `platform` in install.json. Re-running init without `--platform` keeps the stored value. Test that init with `--platform muse` records it and that `currentSignInMethod` in that workspace returns email.
- [ ] Commit: `feat(cli): pick the owner sign-in method from the environment`

### Task 2: Browser method for owner requests

**Files:**
- Modify: `packages/polygon-agent-cli/src/lib/owner/pending.ts`, `packages/polygon-agent-cli/src/lib/owner/requests.ts`, `packages/polygon-agent-cli/src/lib/login-relay-client.ts` (register with optional context)
- Test: `packages/polygon-agent-cli/src/lib/owner/requests.test.ts` (create if absent), `pending` tests next to it

**Interfaces:**
- Consumes: `runBrowserLogin`, `BrowserLoginDeps` (`lib/browser-login.ts`); `makeLoginRelay(relayBase)`; `oidcRelayBaseUrl()`, `loginUiBaseUrl()` (`lib/oms-client.ts`); `ownerWallet(key)`, `OWNER_LOGIN_SECONDS`, `REQUEST_LIFETIME_MS`.
- Produces:
  ```ts
  // pending.ts
  export type PendingRequest = PendingBase & (
    | { method: 'email'; email: string; attempt: EmailAttempt }
    | { method: 'browser'; relaySession: string; email?: string });
  // schema: a missing `method` parses as 'email' (old files)
  export interface LoginContext { purpose: 'connect'|'allowance'|'renew'|'withdraw'|'access'|'owner'; allowanceUsd?: number; days?: number; polymarket?: boolean }
  // requests.ts
  export async function startOwnerRequest(params: { wallet: string; action: OwnerAction; now: Date } & ({ method: 'email'; email: string } | { method: 'browser'; context: LoginContext })): Promise<PendingRequest>;
  export function loginPageUrl(relaySession: string): string; // `${loginUiBaseUrl()}/login#${session}`
  export async function confirmOwnerRequest<T>(params: { wallet; requestId; now; run } & ({ code: string } | { browser: { deps?: Partial<BrowserLoginDeps>; timeoutMs: number } })): Promise<...same as today>;
  ```
  - `makeLoginRelay(...).registerSession(session, context?)` posts `{ session, context }`.

- [ ] Tests for the pending schema:
  - an old file without `method` loads as `method: 'email'`
  - a browser request round-trips
- [ ] Tests for `startOwnerRequest` browser: registers a relay session with the context (fake relay) and saves `method: 'browser'` with `relaySession`. It sends no email.
- [ ] Tests for `confirmOwnerRequest` browser, with an injected fake relay and wallet:
  - `oidc-callback` → signs in, deletes the pending file, runs `run`, revokes
  - `cancel` → error, pending file deleted, nothing run
  - timeout → `request_expired`
  - wrong account against an existing pointer → the same `invalid_input` wrong-account message as the email path, revoke still attempted
  - the email path behaves exactly as before (existing tests stay green)
- [ ] Implement:
  - Split today's `signIn` into `signInOwner(request, owner, input)`.
  - The browser branch calls `runBrowserLogin` with `wallet` adapted from `owner.wallet`, passing `sessionLifetimeSeconds: OWNER_LOGIN_SECONDS` to `startOidcRedirectAuth`, `completeOidcRedirectAuth`, `startEmailAuth` and `completeEmailAuth`.
  - Its `selectMainWallet` returns `{ address }` from the existing post-sign-in main-wallet selection, and `announce` is a no-op.
  - `randomSessionId` returns the stored `relaySession`, which means `runBrowserLogin` must accept an existing session: add an optional `session` field to `BrowserLoginOpts`, and when it's given skip `registerSession`, since start already did that.
  - The deadline is `min(expiresAt, now + timeoutMs)`.
- [ ] Commit: `feat(cli): owner requests can sign in through the browser`

### Task 3: Waiter, `--wait`, and session-mode `wallet login` by default

**Files:**
- Create: `packages/polygon-agent-cli/src/lib/owner/waiter.ts`, `packages/polygon-agent-cli/src/lib/owner/waiter.test.ts`
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts` (login routing and options), `packages/polygon-agent-cli/src/commands/wallet-session.ts` (login and the four other request starters, confirm `--wait` / `--browser-waiter`, status pending), tests `wallet-login.test.ts`, `wallet-session.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // waiter.ts
  export function resultFile(wallet: string, id: string): string; // under the same owner dir as pending, 0600, encrypted like pending
  export function pidFile(wallet: string, id: string): string;
  export async function writeResult(wallet: string, id: string, json: Record<string, unknown>): Promise<void>;
  export function readResult(wallet: string, id: string): Record<string, unknown> | null;
  export function deleteResult(wallet: string, id: string): void;
  export function waiterAlive(wallet: string, id: string): boolean; // pid file + process.kill(pid, 0)
  export function spawnWaiter(params: { wallet: string; id: string }): void; // detached, stdio ignore, unref; argv: [process.execPath, process.argv[1], 'wallet','confirm','--name',wallet,'--request',id,'--browser-waiter']
  export function stopWaiter(wallet: string, id: string): void; // SIGTERM if alive, ignore errors
  export async function waitForResult(params: { wallet: string; id: string; timeoutMs: number; sleep?: (ms:number)=>Promise<void> }): Promise<{ state: 'done'; result: Record<string, unknown> } | { state: 'waiting' } | { state: 'gone' }>;
  ```
- Command behaviour: spec §3 and §4, exactly. JSON shapes:
  - browser start: `{ ok: true, status: 'waiting', method: 'browser', methodReason, request, url, expiresAt, action, plan?, next }`
  - `email_required`: a `CliError` whose `command` is `polygon-agent wallet login --email <email>[ --name n]`
  - `--wait` done: today's confirm JSON. Waiting: `{ ok: true, status: 'waiting', next }`. Gone: `browser_signin_failed` with `command` = the email variant of the same request.

- [ ] Tests for waiter.ts (with a temp `POLYGON_AGENT_HOME`):
  - result round-trip and deletion
  - `waiterAlive` is false for a dead pid
  - `waitForResult` returns done, waiting at the timeout, and gone when there's no pid and no result
- [ ] Command tests (mock `spawnWaiter`, `open` and the picker):
  - bare `wallet login` with the picker on browser → `status: 'waiting'` plus a URL, `spawnWaiter` called, a pending file with `method: 'browser'`
  - picker on email with no email → `email_required`
  - `--email` → today's `code_sent`
  - `--owner` → today's owner flow (the existing owner tests move to `--owner`)
  - a second browser login stops the previous waiter
  - `allowance set` on browser returns `waiting`
  - `wallet status` shows the pending browser request with its URL
  - `wallet confirm --wait`: done, waiting and gone
  - `--browser-waiter`: runs confirm with the browser input and writes the result file. It includes `provisionBuilderOnce` on connect (mocked).
- [ ] Implement:
  - The waiter writes its pid at start and removes it in `finally`.
  - `wallet login` without `--owner` refuses an owner-mode pointer under the same name, with today's message reversed: "signed in with --owner; use another --name or logout".
  - Owner users who ran bare `wallet login` get a stderr note: "`wallet login` now connects with an allowance; use `--owner` for the full owner session."
- [ ] Commit: `feat(cli): session-mode wallet login picks browser or chat code and waits in the background`

### Task 4: Polymarket key at owner-mode sign-in

**Files:**
- Modify: `packages/polygon-agent-cli/src/commands/wallet.ts` (the owner flow after `saveOmsWalletPointer`)
- Test: `packages/polygon-agent-cli/src/commands/wallet-login.test.ts`

**Interfaces:**
- Consumes: `polymarketOwnerStep({ wallet, owner, mainAddress })` from `lib/polymarket/owner-step.ts` (never throws; returns `OwnerStepResult`).

- [ ] Tests:
  - an `--owner` login (fresh and `alreadyLoggedIn`) includes a `polymarket` field and calls the step with the persisted owner client and the main address
  - when the step rejects, the login is still `ok: true` with `polymarket: { backedUp: false, error }`
- [ ] Implement it with `.catch` like `runOwnerAction`. On the `alreadyLoggedIn` path, run it too, so existing owner installs back up their key on the next login.
- [ ] Commit: `feat(cli): owner-mode login backs up the polymarket trading key`

### Task 5: Funding at the right moment

**Files:**
- Modify: `packages/polygon-agent-cli/src/commands/operations.ts` (`showFunding` amount; export `fundingUrl({ walletAddress, chainId, amountUsd? })`), `packages/polygon-agent-cli/src/lib/oms-tx.ts` (`insufficient_balance` gains `funding`), `packages/polygon-agent-cli/src/commands/polymarket/funds.ts` (deposit shortfall gains `funding`), `packages/polygon-agent-cli/src/commands/wallet-session.ts` (connect result gains `funding` when empty), `packages/agentconnect-ui/src/App.tsx` and `src/components/FundingScreen.tsx` (`amount` param)
- Test: the matching `*.test.ts` files

**Interfaces:**
- Produces: `fundingUrl(params): string` → `${fundingUiBase()}/?wallet=&chain=&view=fund[&amount=<usd>]`. `CliError` gains an optional `details?: Record<string, unknown>` that `failureJson` spreads into the output, so `funding` reaches the JSON. Check `lib/errors.ts` first and reuse it if it already has something similar.

- [ ] Tests:
  - a connect result (confirm and `--wait`) on an empty wallet has `funding.url` with `view=fund` and `reason: 'empty'`. A funded wallet has none. Mock `isWalletFunded`.
  - `insufficient_balance` from runTx carries `funding.url`
  - a Polymarket deposit short by X carries `funding.amountUsd` = max(shortfall, 2)
  - `fundingUrl` adds `amount` only when given
  - agentconnect-ui: with `amount=5`, the Trails widget gets 5 USDC on Polygon as the target amount
- [ ] Implement it.
  - In the UI, find the Trails widget prop used in `FundingScreen.tsx` near `token: USDC_POLYGON`, and add the amount using the same widget's amount prop.
  - Pass `amount` from `App.tsx` through `initialFundOpen` to `FundingScreen` as a new optional `amount?: string` prop.
- [ ] Commit: `feat: offer funding when the agent wallet is empty or short`

### Task 6: Relay context and login page copy

**Files:**
- Modify: `packages/oidc-relay/src/relay.ts`, `packages/oidc-relay/src/login-session.ts` (store context at register; status GET returns `{ ...status, context }`; `done` may carry `funding?: { url }`), `packages/agentconnect-ui/src/login/LoginPage.tsx`, `packages/agentconnect-ui/src/login/machine.ts`
- Test: `packages/oidc-relay/src/login-session.test.ts`, `relay.test.ts`, `packages/agentconnect-ui/src/login/machine.test.ts`

- [ ] Relay tests:
  - register with a valid context stores it, and the status GET returns it
  - register without a context still works and returns no context
  - an invalid context is dropped silently, not a 400
  - `done` with `funding.url` round-trips through `parseLoginStatus` only if the URL is `https:`
- [ ] Page tests (machine):
  - the context line for each purpose: connect "Connect your assistant with a $1,000 allowance for 30 days." Add "This also backs up your Polymarket trading key." when `polymarket`.
  - no context → today's copy
  - done with funding → an "Add funds" link
- [ ] The CLI side: Task 2's `registerSession(session, context)` already sends the context. In `confirmOwnerRequest`'s browser `done`, the waiter sets `funding` on the done status when the connect result has `funding`. That needs `runBrowserLogin` to take an optional `doneExtras()` callback, evaluated after the run. If that's awkward, set an extra status after the run instead: `relay.setStatus(session, { status: 'done', walletAddress, funding })`.
- [ ] Commit: `feat(login): show what the sign-in approves and offer funding after connect`

### Task 7: Skills, "agent wallet" wording, changeset

**Files:**
- Modify: `skills/setup.md`, `skills/polygon-oms-wallet/SKILL.md`, `skills/polygon-agent-cli/SKILL.md`, `skills/polygon-polymarket/SKILL.md`, `skills/polygon-defi/SKILL.md`, `skills/polygon-discovery/SKILL.md`; every user-facing "OMS wallet" string in `packages/polygon-agent-cli/src` (messages, hints, `describe`) and the tests asserting them
- Create: `.changeset/signin-methods.md` (`@polygonlabs/agent-cli`: minor; `@polygonlabs/agentconnect-ui`: patch)

- [ ] setup.md:
  - `workspace init` gains `--platform <muse|openclaw|hermes|claude-code|cursor|codex|other>`, with one line telling the assistant to pass its own platform.
  - The connect step becomes: run `wallet login` and follow `next`, then handle the outcomes:
    - `waiting`: "A sign-in page opened in your browser" (or send `url` when it says it couldn't open), then run `next` (`--wait`) until done.
    - `email_required`: ask for the email, then run `next`.
    - `code_sent`: today's steps.
  - Keep the QA banner and the staging raw URLs that are already in this file.
- [ ] polygon-oms-wallet SKILL:
  - The same pattern for every owner request.
  - Add "When any output has `funding`, open or send `funding.url` and tell the user what it's for."
  - "Agent wallet" wording, with the first mention as "your agent wallet (an OMS embedded wallet)".
- [ ] polygon-agent-cli SKILL: document `--owner`, `--wait`, `--platform` and `POLYGON_AGENT_SIGNIN`, and say bare `wallet login` is now session mode.
- [ ] Rename "OMS wallet" to "agent wallet" in the rest of the skills and the CLI strings. Run `grep -rIn "OMS wallet" skills packages/polygon-agent-cli/src`; it should be empty when you're done.
- [ ] Run the full CLI suite, typecheck, lint, and the agentconnect-ui and oidc-relay tests.
- [ ] Commit: `docs(skills): sign-in picked automatically, funding links, agent wallet wording`

## Release (controller, after the final review)

1. Push `signin-methods`, open a PR into `staging`, wait for checks, and merge with a merge commit.
2. Dispatch `npm-release-trigger.yml` on `staging` with `snapshot_tag=polymarket-qa`. Verify the new version on the tag, and that the tarball has the updated skills.
3. Check that `raw.githubusercontent.com/.../staging/skills/setup.md` has the new connect step.
