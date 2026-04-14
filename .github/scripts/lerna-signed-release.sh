#!/usr/bin/env bash
set -euo pipefail

# Creates a signed Lerna version commit via the GitHub API, then publishes to npm.
#
# Why: git commits created locally are unsigned, failing branch-protection
# "require signed commits" rules. Commits created via the GitHub REST API are
# verified by GitHub's web-flow GPG key. We let lerna do all version
# calculations locally (--no-push), capture the resulting tree/parent/message,
# re-create that commit through the API, then update branch and tag refs on
# GitHub — bypassing git push entirely.
#
# Usage:
#   .github/scripts/lerna-signed-release.sh <dist-tag> [<branch>] [--dry-run]
#
# Arguments:
#   dist-tag   npm dist-tag: dev | beta | latest
#   branch     branch to release from (default: main)
#   --dry-run  show what would happen without pushing anything to GitHub or npm
#
# Required environment variables:
#   GITHUB_REPOSITORY  owner/repo, e.g. "0xPolygon/polygon-agent-cli"
#   GH_TOKEN           GitHub token with contents:write scope
#
# Local testing (dry-run):
#   GITHUB_REPOSITORY=0xPolygon/polygon-agent-cli \
#   GH_TOKEN=$(gh auth token) \
#   bash .github/scripts/lerna-signed-release.sh latest main --dry-run
#
# Local testing (live — targets a real branch, not main):
#   GITHUB_REPOSITORY=0xPolygon/polygon-agent-cli \
#   GH_TOKEN=$(gh auth token) \
#   bash .github/scripts/lerna-signed-release.sh dev my-test-branch
#
# Recovery behaviour:
#   The script is safe to re-trigger at any point. Each remote step checks
#   whether it already completed and skips it if so, using the existing state.
#   The one exception is the "branch advanced but tags missing" edge case —
#   the script detects this and exits with a clear error rather than doing
#   something unintended.
#
# Stage ordering and rationale:
#   1. lerna version --no-push  — determines bumps, updates files, local commit + tags
#   2. POST /git/commits        — creates the signed commit object on GitHub
#   3. PATCH /git/refs/heads/*  — makes the signed commit part of branch history
#   4. POST /git/refs (tags)    — tags point to the signed commit (idempotent)
#   5. gh release create        — metadata on top of tags (idempotent)
#
#   npm publish is NOT done here. Each tag push (step 4) triggers the
#   npm-publish.yml workflow, which runs lerna publish from-package independently.
#   This decouples versioning from publishing: if publish fails, re-trigger
#   that workflow without any risk of double-versioning.
#
#   Commit before tags so tags have something to reference.
#   Tags before releases so releases have something to reference.

DRY_RUN=false
POSITIONAL=()
for arg in "$@"; do
  case $arg in
    --dry-run) DRY_RUN=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

DIST_TAG="${POSITIONAL[0]:?Usage: $0 <dist-tag> [<branch>] [--dry-run]}"
BRANCH="${POSITIONAL[1]:-main}"
OWNER_REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY env var is required}"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> DRY RUN — no commits, tags, releases, or npm publishes will happen"
fi

# ---------------------------------------------------------------------------
# Stage 1: lerna version
# ---------------------------------------------------------------------------
echo "==> Stage 1: lerna version (dist-tag=$DIST_TAG, branch=$BRANCH)"

HEAD_BEFORE=$(git rev-parse HEAD)

if [[ "$DIST_TAG" == "latest" ]]; then
  pnpm exec lerna version \
    --conventional-commits \
    --no-push \
    --yes
else
  pnpm exec lerna version \
    --conventional-commits \
    --conventional-prerelease \
    --preid "$DIST_TAG" \
    --no-push \
    --yes
fi

HEAD_AFTER=$(git rev-parse HEAD)

# ---------------------------------------------------------------------------
# Recovery: lerna produced no new commit
#
# Two sub-cases:
#   (a) All version tags already exist on GitHub — everything committed and
#       tagged; only npm publish may be missing. Jump straight to Stage 6.
#   (b) Branch was advanced in a previous run but tags were never created —
#       package.json already shows the new version so lerna skips the bump,
#       but the tags are absent. This state cannot be auto-recovered: we
#       surface a clear error rather than silently create wrong tags or
#       double-bump.
# ---------------------------------------------------------------------------
if [[ "$HEAD_AFTER" == "$HEAD_BEFORE" ]]; then
  echo "==> lerna found no packages to version — checking recovery state"

  MISSING_TAGS=()
  for PKG_JSON in packages/*/package.json; do
    PKG_NAME=$(jq -r '.name' "$PKG_JSON")
    PKG_VERSION=$(jq -r '.version' "$PKG_JSON")
    TAG="${PKG_NAME}@${PKG_VERSION}"
    if ! gh api "repos/${OWNER_REPO}/git/ref/tags/${TAG}" &>/dev/null 2>&1; then
      MISSING_TAGS+=("$TAG")
    fi
  done

  if [[ ${#MISSING_TAGS[@]} -gt 0 ]]; then
    echo ""
    echo "ERROR: lerna made no version commit, but these tags are absent from GitHub:"
    for TAG in "${MISSING_TAGS[@]}"; do
      echo "  - $TAG"
    done
    echo ""
    echo "The branch is likely in a partially-committed state (branch ref was"
    echo "advanced in a previous run but tag creation did not complete)."
    echo "Create the missing tags manually pointing to the current branch HEAD,"
    echo "or reset the branch to before the version commit and re-run from scratch."
    exit 1
  fi

  echo "==> All version tags already exist — nothing to do."
  echo "    The tag-triggered npm-publish.yml workflow handles publishing."
  echo "    Re-trigger that workflow in the GitHub Actions UI if npm publish failed."
  exit 0
fi

# ---------------------------------------------------------------------------
# Stage 2: capture lerna's version commit
# ---------------------------------------------------------------------------
echo "==> Stage 2: capturing lerna's version commit"

TREE_SHA=$(git rev-parse 'HEAD^{tree}')
PARENT_SHA=$(git rev-parse 'HEAD^1')
COMMIT_MSG=$(git log -1 --format='%B')
LERNA_TAGS=$(git tag --points-at HEAD)

echo "  Tree:    $TREE_SHA"
echo "  Parent:  $PARENT_SHA"
echo "  Tags:    $(echo "$LERNA_TAGS" | tr '\n' ' ')"

echo ""
echo "==> Files changed by lerna"
git diff --name-status "$HEAD_BEFORE" HEAD

echo ""
echo "==> Commit message"
echo "$COMMIT_MSG"

# ---------------------------------------------------------------------------
# Dry-run: show planned API calls then restore
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> API calls that would be made"
  echo ""
  echo "  POST https://api.github.com/repos/${OWNER_REPO}/git/commits"
  echo "    tree:       $TREE_SHA"
  echo "    parents[0]: $PARENT_SHA"
  printf '    message:    %s\n' "$(echo "$COMMIT_MSG" | head -1)"
  echo "    (GitHub signs this commit with its web-flow GPG key)"
  echo ""
  echo "  PATCH https://api.github.com/repos/${OWNER_REPO}/git/refs/heads/${BRANCH}"
  echo "    sha: <sha returned by commit creation above>"
  echo "    force: false"
  echo ""
  for TAG in $LERNA_TAGS; do
    echo "  POST https://api.github.com/repos/${OWNER_REPO}/git/refs"
    echo "    ref: refs/tags/${TAG}"
    echo "    sha: <sha returned by commit creation above>"
    echo ""
  done
  for TAG in $LERNA_TAGS; do
    echo "  gh release create ${TAG} --generate-notes --verify-tag"
    echo ""
  done
  echo "  (npm publish handled by tag-triggered npm-publish.yml — not part of this script)"
  echo ""
  echo "==> Verifying tree SHA is consistent"
  RECOMPUTED=$(git rev-parse 'HEAD^{tree}')
  if [[ "$RECOMPUTED" == "$TREE_SHA" ]]; then
    echo "  OK: $TREE_SHA"
  else
    echo "  MISMATCH: expected $TREE_SHA, got $RECOMPUTED" >&2
    exit 1
  fi
  echo ""
  echo "==> Restoring repo state"
  for TAG in $LERNA_TAGS; do
    git tag -d "$TAG"
    echo "  Deleted local tag: $TAG"
  done
  git reset --hard "$HEAD_BEFORE"
  echo "  Reset HEAD to: $(git rev-parse HEAD)"
  echo ""
  echo "Dry run complete. Repo is clean."
  exit 0
fi

# ---------------------------------------------------------------------------
# Stage 3: create signed commit on GitHub
#
# If the branch already shows the correct tree (a previous run advanced the
# ref before failing on tags), reuse that commit rather than creating a new
# one. Tags must all point to the same SHA, so we must not create a second
# signed commit with a different SHA.
# ---------------------------------------------------------------------------
echo "==> Stage 3: creating signed commit"

REMOTE_HEAD=$(gh api "repos/${OWNER_REPO}/git/ref/heads/${BRANCH}" --jq '.object.sha')
REMOTE_TREE=$(gh api "repos/${OWNER_REPO}/git/commits/${REMOTE_HEAD}" --jq '.tree.sha')

if [[ "$REMOTE_TREE" == "$TREE_SHA" ]]; then
  SIGNED_SHA="$REMOTE_HEAD"
  echo "  Branch already shows version changes — reusing existing commit $SIGNED_SHA"
else
  SIGNED_SHA=$(gh api "repos/${OWNER_REPO}/git/commits" \
    --method POST \
    -f message="${COMMIT_MSG}" \
    -f tree="${TREE_SHA}" \
    -F "parents[]=${PARENT_SHA}" \
    --jq '.sha')
  echo "  Created signed commit: $SIGNED_SHA"

  # ---------------------------------------------------------------------------
  # Stage 4: advance branch ref to the signed commit
  # ---------------------------------------------------------------------------
  echo "==> Stage 4: advancing branch ref"
  gh api "repos/${OWNER_REPO}/git/refs/heads/${BRANCH}" \
    --method PATCH \
    -f sha="${SIGNED_SHA}" \
    -F force=false
  echo "  Branch ${BRANCH} → $SIGNED_SHA"
fi

# ---------------------------------------------------------------------------
# Stage 5: create version tags (idempotent — skip existing, fail on mismatch)
# ---------------------------------------------------------------------------
echo "==> Stage 5: creating version tags"

for TAG in $LERNA_TAGS; do
  EXISTING=$(gh api "repos/${OWNER_REPO}/git/ref/tags/${TAG}" --jq '.object.sha' 2>/dev/null || echo "")
  if [[ -n "$EXISTING" ]]; then
    if [[ "$EXISTING" != "$SIGNED_SHA" ]]; then
      echo "ERROR: tag $TAG already exists but points to $EXISTING, not $SIGNED_SHA" >&2
      echo "This tag was created by a different run. Resolve manually." >&2
      exit 1
    fi
    echo "  Tag $TAG already exists at $SIGNED_SHA — skipping"
  else
    gh api "repos/${OWNER_REPO}/git/refs" \
      --method POST \
      -f ref="refs/tags/${TAG}" \
      -f sha="${SIGNED_SHA}"
    echo "  Created tag: $TAG → $SIGNED_SHA"
  fi
done

# ---------------------------------------------------------------------------
# Stage 5b: create GitHub releases (idempotent — skip existing)
# ---------------------------------------------------------------------------
echo "==> Stage 5b: creating GitHub releases"

for TAG in $LERNA_TAGS; do
  if gh release view "$TAG" --repo "${OWNER_REPO}" &>/dev/null 2>&1; then
    echo "  Release $TAG already exists — skipping"
  else
    gh release create "$TAG" \
      --repo "${OWNER_REPO}" \
      --title "${TAG}" \
      --generate-notes \
      --verify-tag
    echo "  Created release: $TAG"
  fi
done

echo "==> Done. Tag push events will trigger npm-publish.yml for each version tag."
