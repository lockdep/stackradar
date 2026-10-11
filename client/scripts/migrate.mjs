#!/usr/bin/env node
/**
 * Apply this app's Drizzle chain — the Auth.js tables in the `auth` schema —
 * under the advisory lock the server migrates under. Run by `docker-entrypoint.sh` before `next start` when
 * `MIGRATE_ON_START=true`, and as the whole job when `MIGRATE_EXIT_AFTER=true`
 * (the chart's optional initializer). The cloud leaves both unset and runs
 * `npx drizzle-kit migrate` from its deploy Job; the two paths write the
 * same journal, `auth.__drizzle_migrations`.
 *
 * Plain Node on the runtime dependencies (`drizzle-orm`, `postgres`) so it
 * runs inside the standalone production image, like `admin-reset-password.mjs`.
 * Reads `DATABASE_URL` and `DATABASE_CA_CERT` like the app does.
 *
 * Two replicas starting together block on `pg_advisory_lock`: one migrates,
 * the other wakes to a finished journal and does nothing. The lock is
 * session-level, so every statement here goes down one connection (`max: 1`).
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Must equal the server's `MIGRATION_LOCK_KEY` (server/src/db/migrate.ts):
 * both chains run against one database, and a client and a server replica
 * starting together must not interleave DDL. The root
 * `scripts/check-cross-app-constants.mjs` fails CI if the two drift.
 */
export const MIGRATION_LOCK_KEY = 7265827401;

/** Must match `migrations` in drizzle.config.ts (same check script). */
export const MIGRATIONS_SCHEMA = 'auth';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

function migrationsFolder() {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 4; depth++) {
        const candidate = join(dir, 'drizzle');
        if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
        dir = resolve(dir, '..');
    }
    throw new Error('could not find the drizzle/ migrations directory next to scripts/');
}

/**
 * Refuse the one database this must never run against: the cloud's old,
 * separate client database, where the Auth.js tables are still in `public`.
 * Running the new chain there would create empty `auth.*` tables beside the
 * live ones and sign everyone out. The server's database has no
 * `public.accounts`, so the check is exact.
 */
async function refuseLegacyClientDatabase(sql) {
    const [row] = await sql`
        SELECT
            to_regclass('public.accounts') IS NOT NULL AS legacy_tables,
            to_regclass('auth.accounts') IS NOT NULL AS moved
    `;
    if (row.legacy_tables && !row.moved) {
        throw new Error(
            'DATABASE_URL points at the old separate client database (Auth.js tables in `public`). ' +
                "The client's tables live in the `auth` schema of the server's database; " +
                "point DATABASE_URL at that database once the rows from the old one's `public` Auth.js tables have been moved into its `auth` schema.",
        );
    }
}

export async function runMigrations(url = process.env.DATABASE_URL) {
    if (!url) throw new Error('DATABASE_URL is not set');
    const sql = postgres(url, {
        max: 1,
        onnotice: () => {},
        ...(process.env.DATABASE_CA_CERT
            ? { ssl: { rejectUnauthorized: true, ca: process.env.DATABASE_CA_CERT } }
            : {}),
    });
    try {
        await refuseLegacyClientDatabase(sql);
        await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
        try {
            await migrate(drizzle(sql), {
                migrationsFolder: migrationsFolder(),
                migrationsSchema: MIGRATIONS_SCHEMA,
                migrationsTable: MIGRATIONS_TABLE,
            });
        } finally {
            await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
        }
    } finally {
        await sql.end();
    }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    const startedAt = Date.now();
    try {
        await runMigrations();
        console.log(
            JSON.stringify({
                level: 30,
                time: Date.now(),
                msg: 'client migrations applied',
                durationMs: Date.now() - startedAt,
            }),
        );
    } catch (err) {
        console.error(
            JSON.stringify({
                level: 60,
                time: Date.now(),
                msg: 'client migrations failed',
                err: String(err?.message ?? err),
            }),
        );
        process.exit(1);
    }
}
