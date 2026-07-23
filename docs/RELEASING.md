# Releasing

This repository uses [Changesets](https://github.com/changesets/changesets) to
automate versioning, changelog generation, GitHub releases, and npm publishing.
Releases run through the shared `0xPolygon/pipelines` GitHub Actions workflows.

## Adding a changeset

Every PR that changes a published package should include a changeset. Run:

```
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
   - creates a GitHub Release with the changelog as the body.

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

```
type(optional-scope): description
```

Common types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`.
Commits that don't follow the format are rejected locally.

### Private packages

`@polygonlabs/agentconnect-ui` (the browser-login web app) and
`@polygonlabs/oidc-relay` (the login pairing relay) are marked
`"private": true` and are never published to npm. They deploy as Cloudflare
Workers via their own `deploy-*` workflows; Changesets only versions and
git-tags them.

## Viewing releases

Published releases and their changelogs:
https://github.com/0xPolygon/polygon-agent-cli/releases
