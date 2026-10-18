#!/bin/bash
# Build the server and client images from this checkout and start the Compose
# quickstart on them, from an empty database.
#
#   scripts/fresh-local.sh               # wipe, build, up, wait until healthy
#   scripts/fresh-local.sh --keep-data   # rebuild and restart, keep the database
#   scripts/fresh-local.sh --no-cache    # rebuild every layer
#   OSV_ECOSYSTEMS=Alpine scripts/fresh-local.sh   # a 2-minute mirror instead of the default list
#
# The stack is deploy/compose/docker-compose.yml with dev/local-build.yml on
# top: the quickstart's Postgres and fixtures, images built from ./server and
# ./client, project name `stackradar-local`, and its own ports so that it
# runs next to `pnpm dev` (UI 3100, API 8180, Postgres 5445; LOCAL_UI_PORT,
# LOCAL_API_PORT and LOCAL_DB_PORT move them). Only that project's containers
# and volume are removed; the development Postgres of the root
# docker-compose.yml and any snapshot or release quickstart are left alone.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

keep_data=false
build_args=()
for arg in "$@"; do
  case "$arg" in
    --keep-data) keep_data=true ;;
    --no-cache)  build_args+=(--no-cache) ;;
    -h|--help)   sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

export LOCAL_UI_PORT="${LOCAL_UI_PORT:-3100}"
export LOCAL_API_PORT="${LOCAL_API_PORT:-8180}"
export LOCAL_DB_PORT="${LOCAL_DB_PORT:-5445}"
export GIT_SHA="${GIT_SHA:-$(git rev-parse HEAD 2>/dev/null || true)}"

compose() {
  docker compose --project-directory "$ROOT_DIR" \
    -f deploy/compose/docker-compose.yml -f dev/local-build.yml "$@"
}

if [ "$keep_data" = true ]; then
  echo "Stopping the previous instance (keeping its database)..."
  compose down --remove-orphans
else
  echo "Stopping the previous instance and removing its database volume..."
  compose down --volumes --remove-orphans
fi

# Fail here, with the holder's name, rather than inside `up` after the build.
if command -v lsof >/dev/null; then
  for spec in "UI:$LOCAL_UI_PORT:LOCAL_UI_PORT" "API:$LOCAL_API_PORT:LOCAL_API_PORT" "Postgres:$LOCAL_DB_PORT:LOCAL_DB_PORT"; do
    IFS=: read -r what port var <<<"$spec"
    holder="$( (lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) | awk 'NR==2 {print $1 " (pid " $2 ")"}')"
    if [ -n "$holder" ]; then
      echo "Port $port ($what) is held by $holder; stop it or set $var to another port." >&2
      exit 1
    fi
  done
fi

echo "Building stackradar-server:local and stackradar-client:local from $ROOT_DIR..."
compose build ${build_args[@]+"${build_args[@]}"}

echo "Starting Postgres, server and client; waiting until all three are healthy..."
compose up -d --wait

cat <<MSG

Up, on images built from ${GIT_SHA:-this checkout}.

  UI        http://localhost:$LOCAL_UI_PORT     admin@stackradar.local / admin (you will be asked to change it)
  API       http://localhost:$LOCAL_API_PORT
  Postgres  postgresql://stackradar:stackradar-fixture-db-password@127.0.0.1:$LOCAL_DB_PORT/stackradar

Upload an SBOM with the fixture scanner key (docs/self-hosting/docker-compose.md § "Upload an SBOM"):
  X-API-Key: stackradar-fixture-bootstrap-scanner-key

  scripts/fresh-local.sh --keep-data   rebuild and restart without losing the database
  docker compose -p stackradar-local logs -f server
  docker compose -p stackradar-local down --volumes
MSG
