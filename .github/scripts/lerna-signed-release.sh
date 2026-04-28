#!/usr/bin/env bash
set -euo pipefail

# Creates a signed Lerna version commit via the GitHub GraphQL API, then
# triggers npm publish via version tags.
#
# Why GraphQL, not REST: POST /repos/.../git/commits (REST) creates raw git
# objects and does NOT sign them. The GraphQL createCommitOnBranch mutation
# creates a commit that GitHub marks as verified (signed), satisfying the
# "require signed commits" branch protection rule. It also advances the branch
# ref atomically — no separate PATCH needed.
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
#   2. createCommitOnBranch     — GraphQL mutation: creates signed commit, advances branch
#   3. POST /git/refs (tags)    — tags point to the signed commit (idempotent)
#   4. gh release create        — metadata on top of tags (idempotent)
#
#   npm publish is NOT done here. Each tag push (step 3) triggers the
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
#   (a) All version tags already exist — everything committed and tagged.
#       Exit cleanly; npm-publish.yml handles publishing.
#   (b) Branch was advanced in a previous run (signed commit exists) but tag
#       creation didn't complete. lerna skips the bump because package.json
#       already shows the new version. Use the remote branch HEAD as the
#       signed SHA and create the missing tags.
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

  if [[ ${#MISSING_TAGS[@]} -eq 0 ]]; then
    echo "==> All version tags already exist — nothing to do."
    echo "    Re-trigger npm-publish.yml in the GitHub Actions UI if publish failed."
    exit 0
  fi

  # The signed version commit is already on the branch — use its SHA.
  RECOVERY_SHA=$(gh api "repos/${OWNER_REPO}/git/ref/heads/${BRANCH}" --jq '.object.sha')
  echo "==> Branch already at version commit ($RECOVERY_SHA) — creating missing tags"

  for TAG in "${MISSING_TAGS[@]}"; do
    gh api "repos/${OWNER_REPO}/git/refs" \
      --method POST \
      -f ref="refs/tags/${TAG}" \
      -f sha="${RECOVERY_SHA}"
    echo "  Created tag: $TAG → $RECOVERY_SHA"
  done

  for TAG in "${MISSING_TAGS[@]}"; do
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

  echo "==> Done. npm-publish.yml triggered by create: event for each tag."
  exit 0
fi

# ---------------------------------------------------------------------------
# Stage 2: capture lerna's version commit
# ---------------------------------------------------------------------------
echo "==> Stage 2: capturing lerna's version commit"

TREE_SHA=$(git rev-parse 'HEAD^{tree}')
PARENT_SHA=$(git rev-parse 'HEAD^1')
LERNA_TAGS=$(git tag --points-at HEAD)
COMMIT_HEADLINE=$(git log -1 --format='%s')
COMMIT_BODY=$(git log -1 --format='%b')

echo "  Tree:    $TREE_SHA"
echo "  Parent:  $PARENT_SHA"
echo "  Tags:    $(echo "$LERNA_TAGS" | tr '\n' ' ')"

echo ""
echo "==> Files changed by lerna"
git diff --name-status "$HEAD_BEFORE" HEAD

echo ""
echo "==> Commit message"
git log -1 --format='%B'

# ---------------------------------------------------------------------------
# Build file changes for the GraphQL mutation.
# createCommitOnBranch takes explicit file additions/deletions rather than
# a tree SHA, which is how it can sign the commit without requiring the tree
# to already exist in GitHub's object store.
#
# Each file's base64-encoded contents can easily exceed Linux's per-argument
# ARG_MAX (~128 KB) — pnpm-lock.yaml alone blows past it. Pass content via
# `jq --rawfile` (a file read), not `--arg` (an argv slot). Accumulate the
# JSON arrays directly in temp files so we never round-trip a multi-megabyte
# blob through a shell variable.
# ---------------------------------------------------------------------------
ADDITIONS_FILE=$(mktemp /tmp/lerna-release-additions-XXXXXX.json)
DELETIONS_FILE=$(mktemp /tmp/lerna-release-deletions-XXXXXX.json)
CONTENT_FILE=$(mktemp /tmp/lerna-release-content-XXXXXX.b64)
trap 'rm -f "$ADDITIONS_FILE" "$DELETIONS_FILE" "$CONTENT_FILE"' EXIT

printf '[]' > "$ADDITIONS_FILE"
printf '[]' > "$DELETIONS_FILE"

while IFS=$'\t' read -r STATUS FILEPATH; do
  case "$STATUS" in
    A | M)
      git show "HEAD:${FILEPATH}" | base64 | tr -d '\n' > "$CONTENT_FILE"
      jq --arg p "$FILEPATH" --rawfile c "$CONTENT_FILE" \
        '. += [{"path": $p, "contents": $c}]' "$ADDITIONS_FILE" \
        > "${ADDITIONS_FILE}.next"
      mv "${ADDITIONS_FILE}.next" "$ADDITIONS_FILE"
      ;;
    D)
      jq --arg p "$FILEPATH" '. += [{"path": $p}]' "$DELETIONS_FILE" \
        > "${DELETIONS_FILE}.next"
      mv "${DELETIONS_FILE}.next" "$DELETIONS_FILE"
      ;;
  esac
done < <(git diff --name-status "$PARENT_SHA" HEAD)

# ---------------------------------------------------------------------------
# Dry-run: show planned API calls then restore
# ---------------------------------------------------------------------------
if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> API calls that would be made"
  echo ""
  echo "  GraphQL createCommitOnBranch mutation"
  echo "    branch:          ${OWNER_REPO}@${BRANCH}"
  echo "    expectedHeadOid: $PARENT_SHA"
  echo "    headline:        $COMMIT_HEADLINE"
  echo "    additions:       $(jq 'length' "$ADDITIONS_FILE") file(s)"
  echo "    deletions:       $(jq 'length' "$DELETIONS_FILE") file(s)"
  echo "    (GitHub signs this commit as verified)"
  echo ""
  for TAG in $LERNA_TAGS; do
    echo "  POST https://api.github.com/repos/${OWNER_REPO}/git/refs"
    echo "    ref: refs/tags/${TAG}"
    echo "    sha: <oid returned by createCommitOnBranch above>"
    echo ""
  done
  for TAG in $LERNA_TAGS; do
    echo "  gh release create ${TAG} --generate-notes --verify-tag"
    echo ""
  done
  echo "  (npm-publish.yml triggered by create: event for each tag above)"
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
# Stage 3: create signed commit via GraphQL createCommitOnBranch
#
# Unlike POST /git/commits (REST), this mutation:
#   - Signs the commit (appears as "verified" in GitHub)
#   - Advances the branch ref atomically — no separate PATCH needed
#   - Takes file changes directly, so the tree doesn't need to pre-exist
#
# If the branch already shows the correct tree (a previous run completed
# this stage before failing on tags), reuse that commit SHA.
# ---------------------------------------------------------------------------
echo "==> Stage 3: creating signed commit (GraphQL createCommitOnBranch)"

REMOTE_HEAD=$(gh api "repos/${OWNER_REPO}/git/ref/heads/${BRANCH}" --jq '.object.sha')
REMOTE_TREE=$(gh api "repos/${OWNER_REPO}/git/commits/${REMOTE_HEAD}" --jq '.tree.sha')

if [[ "$REMOTE_TREE" == "$TREE_SHA" ]]; then
  SIGNED_SHA="$REMOTE_HEAD"
  echo "  Branch already shows version changes — reusing existing commit $SIGNED_SHA"
else
  # Write the full GraphQL request body to a temp file. Using gh api -F to
  # pass nested JSON with large base64 payloads is unreliable; --input avoids
  # all shell escaping and size issues. Additions/deletions are loaded via
  # --slurpfile from the files already populated above.
  GQL_TMPFILE=$(mktemp /tmp/lerna-release-graphql-XXXXXX.json)
  trap 'rm -f "$ADDITIONS_FILE" "$DELETIONS_FILE" "$CONTENT_FILE" "$GQL_TMPFILE"' EXIT

  jq -n \
    --arg query 'mutation CreateSignedCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) { commit { oid } }
    }' \
    --arg repo "$OWNER_REPO" \
    --arg branch "$BRANCH" \
    --arg headline "$COMMIT_HEADLINE" \
    --arg body "$COMMIT_BODY" \
    --arg expectedHeadOid "$PARENT_SHA" \
    --slurpfile additions "$ADDITIONS_FILE" \
    --slurpfile deletions "$DELETIONS_FILE" \
    '{
      "query": $query,
      "variables": {
        "input": {
          "branch": {"repositoryNameWithOwner": $repo, "branchName": $branch},
          "message": {"headline": $headline, "body": $body},
          "fileChanges": {"additions": $additions[0], "deletions": $deletions[0]},
          "expectedHeadOid": $expectedHeadOid
        }
      }
    }' > "$GQL_TMPFILE"

  SIGNED_SHA=$(gh api graphql --input "$GQL_TMPFILE" \
    --jq '.data.createCommitOnBranch.commit.oid')

  echo "  Created signed commit: $SIGNED_SHA"
  echo "  Branch ${BRANCH} advanced (atomic via GraphQL mutation)"
fi

# ---------------------------------------------------------------------------
# Stage 4: create version tags (idempotent — skip existing, fail on mismatch)
# ---------------------------------------------------------------------------
echo "==> Stage 4: creating version tags"

for TAG in $LERNA_TAGS; do
  # Use assignment-level || so that a 404 (non-zero exit) overrides any
  # stdout the failed gh api wrote, rather than appending to it.
  EXISTING=$(gh api "repos/${OWNER_REPO}/git/ref/tags/${TAG}" --jq '.object.sha' 2>/dev/null) || EXISTING=""
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
# Stage 4b: create GitHub releases (idempotent — skip existing)
# ---------------------------------------------------------------------------
echo "==> Stage 4b: creating GitHub releases"

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

echo "==> Done. npm-publish.yml will be triggered by the create: event for each tag."
