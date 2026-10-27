#!/bin/bash
# The stack the end-to-end tests run against: the Compose quickstart on
# images built from this checkout, project `stackradar-e2e`.
#
#   e2e/scripts/stack.sh up      # build (unless E2E_SKIP_BUILD=1), start, wait until healthy
#   e2e/scripts/stack.sh down    # stop and remove the containers AND the database volume
#   e2e/scripts/stack.sh logs    # print the three containers' logs (`logs -f server` follows one)
#   e2e/scripts/stack.sh ps
#
# playwright.config.ts runs `up` from its global setup unless E2E_BASE_URL
# points at a stack that is already running, and `down` from its global
# teardown when E2E_TEARDOWN=1 (the CI workflow sets it). Locally the stack
# stays up between runs: the tests are written to pass again on a database
# that has already seen them.
#
# Ports (all on 127.0.0.1): E2E_UI_PORT 3200, E2E_API_PORT 8280,
# E2E_DB_PORT 5446. They feed dev/local-build.yml's LOCAL_* variables.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

export LOCAL_UI_PORT="${E2E_UI_PORT:-3200}"
export LOCAL_API_PORT="${E2E_API_PORT:-8280}"
export LOCAL_DB_PORT="${E2E_DB_PORT:-5446}"
export GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"

compose() {
  docker compose --project-directory "$ROOT_DIR" \
    -f deploy/compose/docker-compose.yml -f dev/local-build.yml -f e2e/compose.e2e.yml "$@"
}

case "${1:-}" in
  up)
    if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
      echo "Building stackradar-server:local and stackradar-client:local from $ROOT_DIR..."
      compose build
    fi
    echo "Starting Postgres, server and client (project stackradar-e2e); waiting until all three are healthy..."
    compose up -d --wait
    echo "Up: UI http://localhost:$LOCAL_UI_PORT  API http://localhost:$LOCAL_API_PORT  Postgres 127.0.0.1:$LOCAL_DB_PORT"
    ;;
  down)
    compose down --volumes --remove-orphans
    ;;
  logs)
    shift
    compose logs "$@"
    ;;
  ps)
    compose ps
    ;;
  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
