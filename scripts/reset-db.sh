#!/bin/bash

# Database Reset Script
# Stops the database, removes the volume, and starts fresh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

echo "Stopping database container..."
docker compose down

echo "Removing database volume..."
docker volume rm sbom-tracker_postgres_data 2>/dev/null || echo "Volume not found (already removed or never created)"

echo "Starting fresh database..."
docker compose up -d

echo "Waiting for database to be ready..."
until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

# Wait a bit more for init script to complete
sleep 2

echo "Verifying databases..."
docker compose exec -T postgres psql -U postgres -c "\l" | grep -E "server" || echo "Warning: database may not be created yet"

echo ""
echo "Database reset complete!"
echo ""
echo "Database created (one for both apps, as in every deployment):"
echo "  - server  (Express API in \`public\`, Next.js/Auth.js in the \`auth\` schema)"
echo ""
echo "The database is empty. Do not run migrations by hand against a shared"
echo "environment — deployments apply them (self-hosted: at start-up with"
echo "MIGRATE_ON_START=true; the cloud: ArgoCD pre-sync Jobs). Authoring"
echo "migration files (pnpm db:generate) is fine. See CLAUDE.md."

