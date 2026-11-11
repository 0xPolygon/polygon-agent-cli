#!/usr/bin/env bash
# Usage: RELEASE_TAG=<tag> verify-release-tag.sh <package-name> <package-dir>
# Resolves a release tag to the commit it points at and refuses anything that is not a
# stable release of the named package on main. Needs full history (no network access here).
set -euo pipefail

fail() {
  echo "::error::$1"
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "usage: RELEASE_TAG=<tag> $0 <package-name> <package-dir>" >&2
  exit 2
fi
name="$1"
dir="$2"
tag="${RELEASE_TAG:-}"

[ -n "$tag" ] || fail "RELEASE_TAG is empty"

# Literal prefix compare; the tag is never used to build a pattern.
prefix="${name}@"
[ "${tag#"$prefix"}" != "$tag" ] || fail "tag does not start with ${prefix}"
version="${tag#"$prefix"}"

# Stable versions only: a prerelease tag must never reach production.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ "$version" =~ $semver ]] || fail "version is not a stable x.y.z release"

# A manual run uses the scripts of the ref it was started from, so require main.
if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ] && [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  fail "manual runs must be started from main"
fi

# The ancestry check below needs every commit, not a truncated history.
[ "$(git rev-parse --is-shallow-repository)" = "false" ] || fail "repository is shallow; fetch full history"

sha="$(git rev-parse --verify --quiet "refs/tags/${tag}^{commit}")" || fail "tag not found"
git rev-parse --verify --quiet origin/main >/dev/null || fail "origin/main not found"
git merge-base --is-ancestor "$sha" origin/main || fail "tag commit is not on main"

# Guards against a tag that points at a commit whose package is a different version.
manifest="$(git show "${sha}:${dir}/package.json")" || fail "package.json not found at the tagged commit"
printf '%s' "$manifest" | node -e '
const pkg = JSON.parse(require("fs").readFileSync(0, "utf8"));
process.exit(pkg.name === process.argv[1] && pkg.version === process.argv[2] ? 0 : 1);
' "$name" "$version" || fail "package.json name or version does not match the tag"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "sha=${sha}"
    echo "tag=${tag}"
  } >>"$GITHUB_OUTPUT"
else
  echo "sha=${sha}"
  echo "tag=${tag}"
fi
