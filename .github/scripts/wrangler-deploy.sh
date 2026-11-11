#!/usr/bin/env bash
# Usage: wrangler-deploy.sh <package-dir> [wrangler deploy args...]
# Deploys a Worker to production with an exact wrangler pin. Wrangler is not a workspace
# dependency (repo trust policy), so it runs through npx.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <package-dir> [args...]" >&2
  exit 2
fi
dir="$1"
shift

# Exact pins: a floating major picked up a day-old release.
case "$dir" in
  packages/agentconnect-ui) version="4.154.0" ;;
  packages/oidc-relay) version="3.114.17" ;;
  *)
    echo "::error::no wrangler version configured for ${dir}"
    exit 2
    ;;
esac

cd "$dir"
exec npx -y "wrangler@${version}" deploy --env production "$@"
