# Releasing

This repository uses [Lerna](https://lerna.js.org/) with
[conventional commits](https://www.conventionalcommits.org/) to automate
versioning, changelog generation, GitHub releases, and npm publishing.

## Triggering a release

1. Open the [repository page](https://github.com/0xPolygon/polygon-agent-cli)
   in your browser
2. Click **Actions** (tab at the top)
3. Click **Publish / Release NPM Packages** (left sidebar)
4. Click **Run workflow** (top-right button, next to "This workflow has a
   workflow\_dispatch event trigger")
5. Select the **channel**: `latest` (stable), `beta`, or `dev` (prerelease)
6. Select the **branch** (defaults to `main`)
7. Click **Run workflow**

You can ship `dev` or `beta` prereleases from any branch for testing.
**Never ship `latest` from a branch other than `main`.**

## What happens

The workflow runs Lerna, which:

1. **Determines the next version** from conventional commit messages
   since the last release (`feat` → minor bump, `fix` → patch bump,
   `BREAKING CHANGE` in the commit body → major bump).
2. **Creates a commit** containing:
   - Updated `version` fields in `package.json` files
   - Updated `CHANGELOG.md` entries computed from conventional commit
     messages
3. **Tags** the commit with per-package git tags (e.g.,
   `@polygonlabs/agent-cli@0.2.0`).
4. **Creates a GitHub release** with the changelog as the body.
5. **Publishes** any packages that don't have `"private": true` to npm
   (using OIDC trusted publishing — no long-lived npm tokens).

Changelogs are maintained on a per-package basis, automatically:

- [agent-cli changelog](../../packages/polygon-agent-cli/CHANGELOG.md)
- [connector-ui changelog](../../packages/connector-ui/CHANGELOG.md)

The workflow lives in `.github/workflows/release.yml`.

## Channels

| Channel  | Version example       | npm install                              |
|----------|-----------------------|------------------------------------------|
| latest   | 0.2.0                 | `npm i @polygonlabs/agent-cli`           |
| beta     | 0.3.0-beta.1          | `npm i @polygonlabs/agent-cli@beta`      |
| dev      | 0.3.0-dev.1           | `npm i @polygonlabs/agent-cli@dev`       |

## Rules

### Never edit `version` in `package.json` manually

The release bot manages all version fields. Manual edits will cause the
release workflow to produce incorrect versions or fail entirely. See
[this commit](https://github.com/0xPolygon/polygon-agent-cli/commit/631d8145febe0932cb511ec98ebd83fbe006fcd5)
for what a bot-managed release commit looks like.

### Commit messages matter

Commit messages drive both version bumps and changelog content. Every
commit that lands on `main` should follow the conventional commit format:

```
type(optional-scope): description
```

Common types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`, `ci`.

Only `feat` and `fix` appear in the changelog and influence version
bumps. Use `chore`, `refactor`, etc. for changes that shouldn't be
user-visible in release notes.

This is enforced by a commitlint hook via Husky — commits that don't
follow the format will be rejected locally.

Remember: your commit messages are written into the official GitHub
Release and `CHANGELOG.md` files and describe changes for consumers
of the repo and packages.

### Private packages

`@polygonlabs/agent-connector-ui` is marked `"private": true` and is
never published to npm. Lerna still tracks its version and changelog
for internal reference.

## Viewing releases

Published releases and their changelogs:
https://github.com/0xPolygon/polygon-agent-cli/releases
