#!/bin/bash
# Throw away the local development database and start an empty one.
#
# Removes the root docker-compose.yml Postgres together with its volume, so
# the next start re-runs scripts/init-db.sql. Local only: it operates on the
# Compose project in this directory and nothing else.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "Stopping the database and removing its volume..."
docker compose down --volumes

echo "Starting an empty database..."
docker compose up -d

echo "Waiting for Postgres to accept connections..."
until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done
# The init script runs right after the server first answers.
sleep 2

docker compose exec -T postgres psql -U postgres -c "\l" | grep -qE "^ server " \
  && echo "Database 'server' is ready." \
  || echo "Warning: database 'server' not visible yet; check 'docker compose logs postgres'."

cat <<'MSG'

The database is empty. Both apps create their tables at start-up:
  server:  MIGRATE_ON_START=true pnpm dev
  client:  pnpm db:migrate:boot   (or MIGRATE_ON_START=true pnpm dev)
Never point either at a database you do not own. See DEVELOPING.md.
MSG
