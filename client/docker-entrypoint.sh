#!/bin/sh
# The image's entrypoint. Self-hosted installs set
# MIGRATE_ON_START=true and get this app's migrations applied before the
# server starts, under the advisory lock the server's own migrator takes, so
# any number of client and server replicas can start at once.
# MIGRATE_EXIT_AFTER=true turns the container into a one-shot initializer
# (the chart's optional pre-install Job) that migrates and exits. The cloud
# sets neither: its deploy Job runs the migration, and this just execs the
# command. Nothing here writes to the filesystem, so readOnlyRootFilesystem
# holds.
set -eu

if [ "${MIGRATE_ON_START:-}" = "true" ] || [ "${MIGRATE_EXIT_AFTER:-}" = "true" ]; then
    node scripts/migrate.mjs
    if [ "${MIGRATE_EXIT_AFTER:-}" = "true" ]; then
        echo '{"level":30,"msg":"MIGRATE_EXIT_AFTER is set; exiting without starting the server"}'
        exit 0
    fi
fi

exec "$@"
