#!/usr/bin/env bash
# Usage: wrangler-deploy.sh <package-dir> [wrangler deploy args...]
# Deploys a Worker to production. Run it after the job's frozen install.
#
# agentconnect-ui: wrangler is a devDependency of the package, so the version that runs is the
# one in the lockfile and no package is installed at deploy time.
# oidc-relay: wrangler is not a dependency yet (it stays on wrangler 3), so it runs through npx
# at an exact version.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <package-dir> [args...]" >&2
  exit 2
fi
dir="$1"
shift

case "$dir" in
  packages/agentconnect-ui)
    cd "$dir"
    # Exits 3 when package.json was read and has no wrangler dependency. Any other failure
    # means it could not be read, which must stop the deploy too.
    status=0
    node -e '
      const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
      process.exit(pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler ? 0 : 3);
    ' || status=$?
    if [ "$status" -eq 3 ]; then
      echo "::error::this release predates deploys that run wrangler from the lockfile; roll back from the Worker's deployment history in Cloudflare instead"
      exit 1
    elif [ "$status" -ne 0 ]; then
      echo "::error::could not read ${dir}/package.json to check for the wrangler dependency"
      exit 1
    fi
    exec pnpm exec wrangler deploy --env production "$@"
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
