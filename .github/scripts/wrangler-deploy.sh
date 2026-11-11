#!/usr/bin/env bash
# Usage: wrangler-deploy.sh <package-dir> [wrangler deploy args...]
# Deploys a Worker to production. Run it after the job's frozen install.
#
# agentconnect-ui: wrangler is a devDependency of the package, so the version that runs is the
# one in the lockfile and nothing is fetched at deploy time.
# oidc-relay: wrangler is not a dependency yet (it stays on wrangler 3), so it runs through npx
# at an exact version.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <package-dir> [args...]" >&2
  exit 2
fi
dir="$1"
shift

has_wrangler_dependency() {
  node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    process.exit(pkg.devDependencies?.wrangler ? 0 : 1);
  '
}

case "$dir" in
  packages/agentconnect-ui)
    cd "$dir"
    if has_wrangler_dependency; then
      exec pnpm exec wrangler deploy --env production "$@"
    fi
    # Redeploying a release tag from before wrangler was a dependency: that tree's lockfile
    # has no wrangler, so use the version those releases were deployed with.
    exec npx -y "wrangler@4.154.0" deploy --env production "$@"
    ;;
  packages/oidc-relay)
    cd "$dir"
    exec npx -y "wrangler@3.114.17" deploy --env production "$@"
    ;;
  *)
    echo "::error::no wrangler deploy configured for ${dir}"
    exit 2
    ;;
esac
