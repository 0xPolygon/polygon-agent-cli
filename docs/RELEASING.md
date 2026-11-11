# Releasing

This repository uses [Changesets](https://github.com/changesets/changesets) to
automate versioning, changelog generation, GitHub releases, and npm publishing.
Releases run through the shared `0xPolygon/pipelines` GitHub Actions workflows.

## Adding a changeset

Every PR that changes a published package should include a changeset. Run:

```sh
pnpm changeset
```

Pick the affected package(s) and the bump level (`patch`, `minor`, or
`major`), and write a short summary. This writes a file under `.changeset/`
that you commit with your PR; the summary becomes the changelog entry. A
"Require changeset" check enforces this on PRs to `main`.

The bump level comes from the changeset, not from your commit messages.

## Cutting a release

Releases are automated by the **Release** workflow
(`.github/workflows/npm-release-trigger.yml`, which calls the shared
`0xPolygon/pipelines/.github/workflows/apps-npm-release.yml`). There is no
"run the workflow and pick a channel" step.

1. **Merge changes to `main`.** On each push to `main`, the Release workflow
   collects the pending changesets and opens (or updates) a **"Version
   Packages" PR** on the `changeset-release/main` branch. That PR:
   - bumps the `version` in each affected `package.json`,
   - writes the `CHANGELOG.md` entries from the changesets,
   - deletes the consumed changeset files.
2. **Review and merge the Version Packages PR.** Merging it re-runs the
   Release workflow, which now:
   - publishes every public package to npm via **OIDC trusted publishing**
     (no long-lived npm token),
   - creates a per-package git tag (e.g. `@polygonlabs/agent-cli@0.12.0`),
   - creates a GitHub Release with the changelog as the body,
   - for `@polygonlabs/agentconnect-ui` and `@polygonlabs/oidc-relay`, the new
     tag also triggers that service's production deploy once its tests pass
     (see [Private packages](#private-packages)).

Private packages (`"private": true`) are versioned and git-tagged but never
published to npm.

If a publish step fails (for example, npm trusted publishing has not yet been
configured for a package), fix the cause and re-run the failed release run.
`changeset publish` is idempotent: it publishes any version that is on `main`
but not yet on npm, so no version re-bump is needed.

## Snapshot prereleases

To ship a throwaway prerelease that a downstream consumer can install ahead of
the matching real release, run the Release workflow manually
(**Actions → Release → Run workflow**) and set a **non-semver** `snapshot_tag`
(for example `canary` or `pre-3.9.8`). This publishes under that npm dist-tag
only and skips the lockfile commit, git tag, and GitHub Release. Semver-shaped
values (`3.9.8`, `v3.9.8`, `3.9.8-beta.1`) are rejected.

## Rules

### Never edit `version` in `package.json` manually

Changesets manages every version field through the Version Packages PR. Manual
edits conflict with it or produce incorrect versions.

### Commit messages

Commit messages do **not** drive version bumps (changesets do), but the repo
still enforces the [conventional commit](https://www.conventionalcommits.org/)
format via a commitlint hook (Husky):

```text
type(optional-scope): description
```

Common types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`.
Commits that don't follow the format are rejected locally.

### Private packages

`@polygonlabs/agentconnect-ui` (the browser-login web app) and
`@polygonlabs/oidc-relay` (the login pairing relay) are marked
`"private": true` and are never published to npm. Changesets versions and
git-tags them, and they are deployed as Cloudflare Workers **from their release
tags** by `deploy-agentconnect-ui-release.yml` and
`deploy-oidc-relay-release.yml`. Each runs the same checks as PR CI on the
tagged commit, then deploys to the `production` environment.

Merging a feature PR does not deploy production: production follows the
release, so what is live is always a tagged, tested version. Staging is deployed
from the `staging` branch by `deploy-agentconnect-ui.yml` and
`deploy-oidc-relay.yml`.

A deploy does not change when a new Wrangler release appears. In
both packages Wrangler is a devDependency, and the deploy runs the version
recorded in the lockfile.

### Redeploying or rolling back

Go to **Actions**, pick the service's release workflow, choose **Run workflow**
from `main`, and set `tag` to an earlier release tag. It re-runs the checks on
that tree, then deploys it, so a tag whose checks no longer pass cannot be
redeployed this way. Neither can a tag from before Wrangler was a dependency of
its package: the deploy step fails because that tree has no Wrangler to run.

For an immediate rollback, or to go back to a release that cannot be
redeployed, use the Worker's deployment history in Cloudflare.
That restores the code only: Durable Object migrations and newly created KV
namespaces do not roll back.

Never move or recreate a release tag. A tag is the record of what was deployed.

### Skills changes

A change under `skills/` needs changesets for both `@polygonlabs/agent-cli` and
`@polygonlabs/agentconnect-ui`; the "Require skills changesets" check enforces
this on PRs. The site serves the skills and the CLI bundles them, so both must
release for a change to reach users. Plugins and `npx skills add` read `main`
directly and pick the change up immediately.

## Viewing releases

Published releases and their changelogs:
<https://github.com/0xPolygon/polygon-agent-cli/releases>
