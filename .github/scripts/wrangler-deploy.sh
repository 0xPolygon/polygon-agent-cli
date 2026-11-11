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

# Exits 0 when the package depends on wrangler and 3 when it does not. Any other status means
# package.json could not be read, which must stop the deploy rather than look like "no".
wrangler_dependency_status() {
  node -e '
    const pkg = JSON.parse(require("node:fs").readFileSync("package.json", "utf8"));
    process.exit(pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler ? 0 : 3);
  '
}

case "$dir" in
  packages/agentconnect-ui)
    cd "$dir"
    status=0
    wrangler_dependency_status || status=$?
    case "$status" in
      0)
        exec pnpm exec wrangler deploy --env production "$@"
        ;;
      3)
        # Redeploying a release tag from before wrangler was a dependency of the package: use
        # the version those releases were deployed with.
        exec npx -y "wrangler@4.154.0" deploy --env production "$@"
        ;;
      *)
        echo "::error::could not read ${dir}/package.json to choose how to run wrangler"
        exit 1
        ;;
    esac
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
