# @polygonlabs/oidc-relay

A small Cloudflare Worker that pairs a terminal with a browser during the CLI's
browser login (`agent wallet login`). It is private and never published to npm.

## Why it exists

The CLI often runs on a machine with no usable browser, such as a remote server
or a container, while the person signing in has a browser somewhere else. A
loopback callback on `localhost` cannot bridge that gap. The relay gives both
sides a rendezvous point on the public internet: the CLI shows or opens the
login page, the page talks to the relay, and the CLI polls the relay for the
result. Neither side needs to reach the other directly.

The relay does not authenticate anyone. It only carries pairing state between
the CLI and the login page (the `agentconnect-ui` package).

## How a pairing works

1. The CLI picks a random session id and registers it, optionally with a short
   description of what the sign-in will approve so the page can display it.
2. The login page polls the session's status and submits the user's input
   (chosen method, email, one-time code, or the return URL from the sign-in
   provider).
3. The CLI polls for that input, acts on it, and publishes the next status for
   the page to show, until it reports success or an error.

Properties the design is built to keep:

- **Short-lived.** Each session is one Durable Object that deletes all of its
  state a fixed time after registration (`SESSION_TTL_MS` in
  `src/login-session.ts`). After that, every call reports the session as
  expired.
- **One-time reads.** The CLI's read of the pending input removes it, so a
  one-time code cannot be replayed. Only the latest submission is kept.
- **Minimal storage.** Only the current status, the optional display context,
  and one pending input are stored, and only in the session's own Durable
  Object. Nothing is logged or persisted elsewhere.
- **Validated input.** Session ids, actions and statuses are shape- and
  length-checked, and unknown fields are dropped before anything is stored.
  The return URL must be `https` (or `http` on localhost for development) and
  its host must be on an allow-list in `src/relay.ts`, so an arbitrary URL
  cannot be passed through to the CLI.
- **The session id is the credential.** It is long and random, and anyone who
  has it can read and write that session, so it should be treated like a
  short-lived token. CORS is open because the page and the relay are on
  different origins.

Routes and their payloads are documented at the top of `src/relay.ts`.

## Durable Object

`LoginSession` (`src/login-session.ts`) holds one session. The logic lives in
`LoginSessionCore`, which depends only on a small storage interface so it can be
unit-tested without the Workers runtime. The Durable Object class is bound in
`wrangler.toml`. Renaming, adding or removing a Durable Object class needs a
new entry in the `migrations` list, repeated for each environment, or the
deploy will fail or orphan data.

## Development

From the repository root, install once with `pnpm install`, then:

```sh
pnpm --filter @polygonlabs/oidc-relay run test
pnpm --filter @polygonlabs/oidc-relay run typecheck
```

Scripts are in `package.json`. `dev` runs the Worker locally through Wrangler.

## Deployment

Staging deploys from the `staging` branch. Production deploys from this
package's release tag, after the same checks as PR CI pass on the tagged
commit; merging a feature PR does not deploy it. See
[`docs/RELEASING.md`](../../docs/RELEASING.md) for the release flow, redeploys
and rollbacks.

The Worker has no build step and no runtime dependencies, so Wrangler is run
through `npx` rather than being a workspace dependency. Production deploys pin
its version in `.github/scripts/wrangler-deploy.sh`. Bindings and per-environment
settings are in `wrangler.toml`; production uses a custom domain.
