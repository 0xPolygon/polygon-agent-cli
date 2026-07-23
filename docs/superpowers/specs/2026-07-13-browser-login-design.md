# Browser login via agentconnect-ui

Date: 2026-07-13
Status: approved

## Problem

`polygon-agent wallet login` prints a raw Google sign-in URL. There is no branding, no method choice, and the local/remote split leaks into the UX (`--remote` plus a relay URL for headless hosts). The Sequence SDK supports email OTP auth, but the CLI never wired it up.

## Decision summary

- A branded login page on agentconnect-ui becomes the default `wallet login` experience for all logins, local and remote alike.
- The user picks Google or email on the page. Email OTP entry happens on the page, not in the terminal.
- After a successful login the page shows a success state that points the user to wallet.polygon.technology.
- Architecture is device-flow pairing (approach A): the CLI keeps all key material and drives the SDK auth locally; the page is only an input surface; the relay carries a short-lived two-way session.

Rejected alternatives: a thin wrapper page (cannot do email on the page) and browser-owned auth with session handoff (would move credential material through the relay, and the SDK does not support re-binding a session to another signer).

## Architecture

Three components, all existing packages:

1. `packages/oidc-relay`: gains a second Durable Object class, `LoginSession`, alongside the untouched `OidcHandoff`. Carries the pairing session between browser and CLI.
2. `packages/agentconnect-ui`: gains a `/login` SPA route. Session id arrives in the URL fragment so it never reaches server logs.
3. `packages/polygon-agent-cli`: `handleLogin` becomes an action loop that polls the relay for user input and drives the SDK locally.

The PKCE verifier, the credential signer key, and the wallet session never leave the CLI process. This matches the existing `--remote` security model.

## Relay protocol

New routes under `/api/login`, backed by the `LoginSession` DO (one instance per session id). Session ids are CLI-generated, 128-bit crypto-random, base64url. Validation mirrors the existing `validState` guard. TTL is 10 minutes via the alarm, same as `OidcHandoff`.

| Route | Caller | Purpose |
|---|---|---|
| `POST /api/login/register {session}` | CLI | Arm a session |
| `POST /api/login/action {session, action}` | Browser | Send user input |
| `GET /api/login/next-action?session=` | CLI | Poll for the oldest unconsumed action (one-time read per action) |
| `POST /api/login/status {session, status, ...}` | CLI | Publish current state |
| `GET /api/login/status?session=` | Browser | Poll state (repeat-readable, survives page refresh) |

Actions: `{type:'google'}`, `{type:'email', email}`, `{type:'otp', code}`, `{type:'cancel'}`.

Statuses: `awaiting-method`, `auth-url` (+url), `otp-sent`, `otp-invalid` (+attemptsLeft), `done` (+walletAddress), `error` (+message).

One-time action reads prevent OTP replay. The final `done` or `error` status stays readable until TTL so a refreshed page still resolves.

### OidcHandoff change

`POST /api/oidc/register` accepts an optional `returnTo` URL. After capturing `code`+`state`, the callback 302s the browser to `returnTo` (the branded login page) instead of serving the bare `DONE_HTML`. When `returnTo` is absent, behavior is unchanged, which keeps the `--local` fallback and any old CLI versions working. `returnTo` is validated as an https URL on an allowlisted host (the agentconnect UI domains) before being stored.

The Sequence-allowlisted redirect URI (`/api/oidc/cb`) is untouched, so no Google client or Sequence relay change is needed.

## Flows

### Google

1. CLI registers session S, prints and opens `https://agentconnect.polygon.technology/login#S`.
2. Page polls status (`awaiting-method`), user clicks Continue with Google, page posts `{type:'google'}`.
3. CLI sees the action, calls `startOidcRedirectAuth` pointed at the relay `/api/oidc/cb`, registers the OidcHandoff with `returnTo = login#S`, publishes `auth-url`.
4. Page redirects to the auth URL. Google, then the Sequence relay, then our relay callback captures code+state and 302s back to the login page.
5. CLI polls the existing `/api/oidc/poll`, calls `completeOidcRedirectAuth`, saves the wallet pointer (`loginMethod: 'google'`), publishes `done` with the wallet address.
6. Page shows success and links to wallet.polygon.technology.

### Email

1. Same session setup. User enters their email address, page posts `{type:'email', email}`.
2. CLI calls `startEmailAuth({email})`, publishes `otp-sent`.
3. Page shows the code input. User types the code from their inbox, page posts `{type:'otp', code}`.
4. CLI calls `completeEmailAuth({code})`. Bad code: publish `otp-invalid` with attempts remaining, page re-prompts. Success: save pointer (`loginMethod: 'email'`), publish `done`.

## CLI changes

- `wallet login` defaults to the browser flow. It requires a relay and UI base URL; production values ship as baked-in defaults, overridable via `POLYGON_AGENT_OIDC_RELAY` (existing) and a new `POLYGON_AGENT_LOGIN_UI`.
- `--local` preserves today's loopback flow (raw Google URL, localhost callback). It is also the suggested remedy when session registration fails because the relay is unreachable; the CLI fails fast with that hint rather than auto-falling back.
- `--remote` becomes a deprecated no-op with a notice, since the default flow already works remotely. `--relay-url` still overrides the relay.
- `--provider` only applies to `--local`; in the browser flow the method choice lives on the page.
- Post-login funding: the CLI no longer auto-opens the funding URL when login came through the page (the success page directs the user onward). It still prints the funding panel; `--no-fund` still suppresses it. The `--local` path keeps today's behavior.
- The action loop is factored into a function that takes a relay client and an OMS client so it can be unit-tested with fakes.

## Security notes

- Key material: PKCE verifier and credential signer key stay in the CLI process, unchanged from today.
- The email address and the OTP transit the relay over TLS, are one-time read, live at most 10 minutes, and are useless without the CLI's in-flight SDK auth attempt.
- Session id is unguessable (128-bit) and carried in the URL fragment.
- `returnTo` is host-allowlisted to prevent open-redirect abuse of the callback.
- Sessions are purged on completion; actions cannot be replayed.

## Error handling

- Session TTL expiry: CLI times out with the same message shape as today; the page shows a link-expired state telling the user to re-run `polygon-agent wallet login`.
- Provider errors at Google flow through the existing error capture, surface as CLI errors, and are published as `status: error` for the page.
- OTP retry: bounded by the SDK's attempt limit. `attemptsLeft` is optional in the `otp-invalid` status; the page shows it when the SDK reports it, and shows a terminal error state once attempts are exhausted.
- Cancel on the page ends the CLI command with a non-zero exit and a clear message.

## Deploy prerequisites

- Enable the relay's production custom domain (currently commented out in `packages/oidc-relay/wrangler.toml`) and have Sequence allowlist its `/api/oidc/cb` as a redirect target (same allowlist add as was done for staging).
- Deploy the `/login` route to agentconnect staging and production.
- Ship the CLI with the production relay and UI URLs as defaults.

## Testing

- Relay: handler-level tests for the `LoginSession` DO (register, action queue one-time reads, status repeat reads, TTL purge, invalid session ids), mirroring how `OidcHandoff` is covered.
- CLI: unit tests of the action loop with fake relay and OMS clients (google happy path, email happy path, bad OTP retry, cancel, timeout, relay unreachable).
- UI: component-level tests of the login state machine (method choice, OTP retry, expired, error, success).
- End to end: manual run against agentconnect.staging.polygon.technology and the staging relay before flipping the CLI default.

## Out of scope

- Deleting the legacy loopback path (kept as `--local`).
- Any change to wallet.polygon.technology itself; the success page only links to it.
- Additional OIDC providers; the page offers Google and email only.
- Renaming the oidc-relay package, even though it now carries more than OIDC.
