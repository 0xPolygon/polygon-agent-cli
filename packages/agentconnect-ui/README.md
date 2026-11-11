# @polygonlabs/agentconnect-ui

The Open Money Agent website: a browser dashboard for the wallets the CLI
creates, plus the sign-in and remote MCP server that sit behind it. The
package is private; it is never published to npm and ships as a Cloudflare
Worker.

## Why one package holds both a SPA and a Worker

The Worker serves the built SPA as static assets and answers everything else
(sign-in, the MCP server) on the same origin. Keeping them together means the
page and the API it calls are versioned, tested, tagged and deployed as one
unit, and the session cookie never has to cross an origin.

The Worker also serves the agent skills from the repo's `skills/` directory.
The build copies them into the output so an assistant can be handed one URL
and read the install guide from the site.

## Where things are

- `src/`: the React SPA (Vite, Tailwind). `main.tsx` is the entry point,
  `login/` holds the CLI login-pairing page, `dashboard/` the signed-in
  wallet views, and `config.ts` the build-time settings the SPA reads.
- `worker/`: the Cloudflare Worker. `index.ts` is the entry point and the one
  place to read the routing; `mcp.ts` defines the MCP server and its tools;
  `owner-signin.ts` and `owner-session.ts` own site sign-in and its cookie;
  `money/` holds what MCP connections use to spend.
- `wrangler.toml`: the Worker's bindings, routes, migrations and
  per-environment settings, with comments on why each exists.
- `vite.config.ts` and `skills-index.ts`: the build, including the step that
  copies `skills/` into the output and writes the skill discovery index.
- `.env.example`: the build-time keys the SPA reads. Copy it to `.env`.

The routes, tools, bindings and secrets are defined in those files; read them
rather than a copy of them here. How sign-in and the MCP server fit together,
and why, is described in the agent guide at the repo root.

## Develop and test locally

From the repo root, install once with `pnpm install`, then:

- `pnpm --filter @polygonlabs/agentconnect-ui run dev` starts Vite on port
  4444. This serves the SPA only: Vite does not run the Worker, so anything
  that calls `/api/*` or `/mcp` has no backend behind it locally.
- `npx wrangler@4 dev --env staging --port 8787 --local-upstream localhost:8787`,
  run from this package, runs the Worker locally. It reads its secrets from
  `.dev.vars.staging`, which is gitignored and never committed.
- `pnpm --filter @polygonlabs/agentconnect-ui run test` runs Vitest over both
  halves (`src/**`, `worker/**` and `skills-index.test.ts`). Worker tests run
  in Node, with the Workers runtime module replaced by
  `worker/test-cloudflare-workers.ts` (see `vite.config.ts`).
- `pnpm run lint` at the repo root lints and formats-checks this package with
  the rest (ESLint, the workspace typecheck, Prettier).

## Type checking

There are four tsconfigs: `tsconfig.app.json` (SPA), `tsconfig.worker.json`
(Worker), `tsconfig.node.json` (Vite config and skill index) and a root
`tsconfig.json` that only references the other three.

The SPA and the Worker need different `lib` and `types` settings, which is why
they are separate projects. `pnpm run build` runs `tsc -b`, which checks all
three, before `vite build`.

## Deploying

Merging to the `staging` branch deploys staging. Production is not deployed
from `main`: it deploys from this package's release tag, after the same checks
as PR CI pass on the tagged commit. The workflows and the release flow are
described in [`docs/RELEASING.md`](../../docs/RELEASING.md), including
redeploys and rollbacks.

Deploys run through the GitHub workflows, which supply the build-time keys and
the Worker secrets and pin the Wrangler version; deploy through them rather
than from a laptop.

## Changing skills

Because this site serves `skills/`, a change there is not live until this
package releases. A change under `skills/` therefore needs a changeset for
this package as well as one for `@polygonlabs/agent-cli`; the rule and the
CI check are in the "Skills changes" section of
[`docs/RELEASING.md`](../../docs/RELEASING.md).
