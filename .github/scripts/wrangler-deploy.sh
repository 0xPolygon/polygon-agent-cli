#!/usr/bin/env bash
# Usage: wrangler-deploy.sh <package-dir> [wrangler deploy args...]
# Deploys a Worker to production with the package's own wrangler, after the job's frozen install.
set -euo pipefail

case "${1:-}" in
  packages/agentconnect-ui | packages/oidc-relay) ;;
  *)
    echo "::error::usage: $0 <packages/agentconnect-ui|packages/oidc-relay> [wrangler deploy args...]"
    exit 2
    ;;
esac
cd "$1"
shift
exec pnpm exec wrangler deploy --env production "$@"
