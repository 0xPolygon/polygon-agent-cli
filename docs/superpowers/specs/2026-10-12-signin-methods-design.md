# Sign-in methods: browser and chat code, picked automatically

Date: 2026-10-12. Status: approved in chat (James). Branch: `signin-methods`, from `staging`. Builds on `2026-10-09-polymarket-oms-key-backup-design.md`.

## Goal

Every assistant install connects in session mode (an allowance and a session key), and the CLI picks how the owner proves it's them:

- **Browser.** The agentconnect login page: Google, or an email code typed on the page. Nothing is pasted back into the chat; the CLI finishes on its own.
- **Chat code.** The email code typed into the chat, as today.

The user never chooses. Every owner sign-in, with either method and in either mode, also creates and backs up the Polymarket trading key. An empty wallet is pointed at the funding page at the moment it matters.

## Today

- `wallet login` (no flags) is owner mode, through the browser (`lib/browser-login.ts` `runBrowserLogin`, relay at `oidc-relay`, page at `agentconnect-ui /login`). It keeps a week-long owner session and never touches Polymarket.
- `wallet login --email` is session mode. `startOwnerRequest` sends a code with a throwaway owner key; `wallet confirm --request --code` signs in for `OWNER_LOGIN_SECONDS`, runs `runOwnerAction` (which includes `polymarketOwnerStep`), revokes and signs out. Later owner requests (`allowance set`, `renew`, `withdraw`, `access`) reuse `pointer.email`.
- `showFunding` builds `<fundingUiBase>/?wallet=&chain=&view=fund` and opens it when asked.

## Decisions (James, 2026-10-12)

1. The browser gives session mode with an allowance by default. Owner mode becomes the explicit `--owner` flag.
2. The CLI picks the method from its context; the user is never asked.
3. In the browser method, the CLI completes the sign-in itself. The user doesn't copy anything back.
4. Both modes create the Polymarket trading key at sign-in, because it needs no funds. It must never block the sign-in.
5. Onboarding opens the funding page when the wallet is empty.

## Design

### 1. Owner requests get a sign-in method

`PendingRequest` gains `method: 'email' | 'browser'` (missing means `'email'`, so existing files still load).

- `email`: as today. `email` and `attempt` are required.
- `browser`: `relaySession` (the pairing session id) instead of `email` and `attempt`. `email` is optional.

`confirmOwnerRequest` splits its sign-in step behind one function, `signInOwner(request, owner)`, which returns the same `CompleteWalletAuthResult` either way:

- `email`: today's `signIn` (code, `completeEmailAuth`).
- `browser`: `runBrowserLogin` with the throwaway `owner.wallet` as its wallet, `sessionLifetimeSeconds: OWNER_LOGIN_SECONDS` on both the OIDC and the email calls, and `selectMainWallet` checked against the pointer's address when there is one.

Everything after the sign-in is unchanged: delete the pending file, select the main wallet, `runOwnerAction`, revoke, sign out. All five owner actions work with both methods.

### 2. Picking the method

`lib/signin-method.ts` exports `pickSignInMethod(env): { method: 'browser' | 'email'; reason: string }`. First match wins:

1. `POLYGON_AGENT_SIGNIN=browser|email` (an override for edge cases; never offered to the user).
2. The platform `workspace init` recorded (`--platform`, from `setup.md`): `muse`, `openclaw`, `hermes` mean `email`; `claude-code`, `cursor`, `codex` mean the environment check below.
3. The environment:
   - `email` when `CI` is set, `SSH_CONNECTION` or `SSH_TTY` is set, `/.dockerenv` exists, or on Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`.
   - Otherwise `browser` (macOS, Windows, Linux desktop).

`reason` is a short phrase for the output (`"desktop"`, `"ssh session"`, `"platform muse"`), so a wrong pick is easy to diagnose.

### 3. Commands

- **`wallet login`**, with no `--email` and no `--owner`, is session mode now:
  - **browser:** start a browser request and its waiter (below), open the page (`open`, ignoring failure), and return immediately:
    `{ ok: true, status: 'waiting', method: 'browser', request, url, expiresAt, plan, next: 'polygon-agent wallet login --wait' }`
  - **email:** if there's no email (`--email` or `pointer.email`), fail with `code: 'email_required'` and the hint "Ask the user for their email, then run `next`." Otherwise behave as `--email` does today.
- **`wallet login --email <e>`** always uses the chat code (backwards compatible).
- **`wallet login --owner`** is today's owner flow, unchanged. A one-line stderr note explains the change to anyone running bare `wallet login` who has an owner-mode wallet.
- **`wallet login --wait`** (and **`wallet confirm --request <id> --wait`**) blocks for up to 90 seconds until the waiter writes its result:
  - **finished:** prints the same JSON `wallet confirm` prints today.
  - **still running:** returns `{ status: 'waiting', next: <same command> }`.
  - **waiter gone and no result:** fails with `code: 'browser_signin_failed'` and a `next` that starts the chat-code path.
- **`allowance set`, `renew`, `withdraw`, `access`** use the same picker. With browser they return `status: 'waiting'` and a `--wait` next, as for login. With email they behave as today.
- **`wallet status`** shows a pending browser request as `pending: { method: 'browser', url, approves, expiresAt }`.

### 4. The waiter

`wallet login` and the other request starters spawn `polygon-agent wallet confirm --request <id> --browser-waiter` detached (`spawn(process.execPath, [entry, ...], { detached: true, stdio: 'ignore' }).unref()`), with the same `POLYGON_AGENT_HOME` and workspace environment. It's a hidden option.

- It runs `confirmOwnerRequest` with the browser sign-in. On completion it writes `owner/<wallet>/result-<id>.json` (encrypted like the pending file, `0600`), holding exactly the JSON `wallet confirm` would print, including `provisionBuilderOnce` for a first connect.
- It writes its pid to `owner/<wallet>/waiter-<id>.pid` at start and removes it at exit. `--wait` treats "pid file present and process alive" as running.
- It exits when `runBrowserLogin` times out (at the request's `expiresAt`), when the user cancels on the page, or on error, writing an `{ ok: false, ... }` result each time.
- `--wait` deletes the result file after printing it once.
- A new request for the same wallet replaces the pending file. Its waiter is also stopped (SIGTERM, which runs the existing interrupt handling).

### 5. Polymarket at every sign-in

- Session mode already runs `polymarketOwnerStep` in `runOwnerAction`, so both methods get it with no change.
- Owner mode (`--owner`) runs `polymarketOwnerStep` right after a successful sign-in, with the persisted owner client and the main wallet. It's best effort, and the result appears as `polymarket` in the login JSON.
- The step only generates the key and imports it into OMS. No funds or region checks are needed. The Deposit Wallet deploy stays on the first `polymarket` command.

### 6. Funding

- A successful connect (`wallet confirm`, `--wait` or owner login) checks the balance. When the wallet holds nothing on Polygon, the output includes `funding: { url, reason: 'empty' }`. With the browser method, the waiter's page shows the funding step itself (below), and the CLI also opens the URL when it runs on a desktop. With the chat code, the assistant sends the link.
- `insufficient_balance` errors from `runTx`, and Polymarket `deposit` when the wallet is short, add `funding: { url, amountUsd }`, the amount being what's missing (at least the $2 bridge minimum for a deposit).
- `showFunding`'s URL gains `&amount=<usd>` when there's an amount. `agentconnect-ui` reads `amount` and passes it to the Trails widget as the target amount in USDC on Polygon.

### 7. Login page

- The CLI publishes context when it registers the relay session. `POST /api/login/register` accepts an optional `context: { purpose: 'connect' | 'allowance' | 'renew' | 'withdraw' | 'access' | 'owner', allowanceUsd?, days?, polymarket?: boolean }`, stored with the session. `GET /api/login/status` returns it alongside the status. It's optional, so old CLIs and pages keep working.
- The page shows one line above the sign-in buttons: for example, "Connect your assistant with a $1,000 allowance for 30 days. This also backs up your Polymarket trading key." Without context it shows today's copy.
- After `done`, when the CLI published `funding` in the done status, the page shows "Add funds" linking to the funding URL.

### 8. Skills

- `skills/setup.md`: `workspace init` gets `--platform <muse|openclaw|hermes|claude-code|cursor|codex|other>`, and the connect step becomes "run `wallet login`, then follow `next`". The assistant handles both outcomes: `waiting` (tell the user to finish in the browser tab that opened, or send them the `url`, then run `--wait`) and `email_required` / `code_sent` (today's chat-code steps).
- `skills/polygon-oms-wallet/SKILL.md`: the same for every owner request, and the funding link rule ("when output has `funding`, send or open its `url`").
- `skills/polygon-agent-cli/SKILL.md`: `--owner`, `--wait`, `POLYGON_AGENT_SIGNIN`.

### 9. "Agent wallet" instead of "OMS wallet"

User-facing text says "agent wallet", not "OMS wallet": every skill under `skills/`, CLI messages, hints and `describe` strings in `packages/polygon-agent-cli/src`, and the login page. About 40 lines today.

- "OMS account", "OMS session key" and the platform name OMS stay as they are.
- Code identifiers (`OMSWallet`, `oms-*` files, JSON field names) don't change.
- The first mention in `setup.md` and `polygon-oms-wallet/SKILL.md` says "your agent wallet (an OMS embedded wallet)" once, so readers who know OMS can place it.
- Tests that assert on the old strings are updated with them.

## Error codes

New: `email_required`, `browser_signin_failed`. Existing codes carry over.

## Out of scope

- A magic-link email (OMS email auth is code-based).
- Google sign-in that also captures the email address (the SDK doesn't return it). After a Google connect, a later chat-code request asks for the email once and stores it.
- Removing owner mode.

## Testing

- **Unit:**
  - `pickSignInMethod` for each signal and the precedence order.
  - `PendingRequest` schema: old files without `method` still load.
  - `signInOwner` for browser, with a faked relay and wallet: done, cancel, timeout, wrong account.
  - Waiter result and pid files: `--wait` covers done, running, waiter dead with no result, and deleting the result once it's read.
  - Owner-mode login calls `polymarketOwnerStep`, and a failure there doesn't fail the login.
  - Funding fields on an empty connect and on `insufficient_balance`.
  - Relay `context` round-trips, and register works without it.
  - The login page renders context copy, and old copy without it.
- **Command tests** through yargs with `--dry-run` where a write is involved.
- **Live (James):** a browser connect from a laptop Claude Code session (Google), and a chat-code connect from a sandbox. Then the staging Polymarket test from the QA guide.
