import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Migrations on boot (docs/open-source-plan-2026-10-10.md step 05).
 *
 * A self-hosted install has no deploy pipeline to run a migration Job for
 * it, so the server applies its own Drizzle chain when told to
 * (`MIGRATE_ON_START=true`) before it listens. Two replicas starting
 * together serialise on a Postgres **session-level advisory lock**: one
 * migrates, the other blocks on the lock, then finds nothing left to do.
 * That is Dependency-Track 5's init-task model, and it is what lets the
 * default chart install work with no hook Job at all. The same image is the
 * optional one-shot "initializer" with `MIGRATE_EXIT_AFTER=true`.
 *
 * The cloud keeps its explicit PreSync Jobs (`npx drizzle-kit migrate`) and
 * leaves both flags unset; the two paths write the same journal
 * (`drizzle.__drizzle_migrations`), so switching between them is free.
 *
 * Deliberately **not** the app's pool (`db/index.ts`): that pool sets a
 * 120 s `statement_timeout` sized for queries, and a backfill migration on
 * a populated database may legitimately run longer. One dedicated
 * connection, no timeouts, closed when done. The lock is session-level, so
 * it must be taken and released on that same connection — `max: 1` is
 * what guarantees every statement here shares it.
 */

/**
 * The advisory-lock key both apps migrate under. The client (`auth` schema,
 * `client/scripts/migrate.mjs`) uses the **same** key on purpose: since
 * step 05 both chains run against one database, and a client replica and a
 * server replica starting together must not interleave DDL in it. Checked
 * against the client's copy by `scripts/check-cross-app-constants.mjs`.
 * Distinct from the OSV sync's lock (`osv-sync/config.ts`).
 */
export const MIGRATION_LOCK_KEY = 7_265_827_401;

export interface RunMigrationsOptions {
    /** Connection string; the app's `config.database.url` in production. */
    url: string;
    /** PEM of the CA to verify the server against, or empty (`DATABASE_CA_CERT`). */
    caCert?: string;
    /** Where the chain lives. Defaults to the package's `drizzle/` directory. */
    migrationsFolder?: string;
    log?: Pick<Console, "info"> | { info: (obj: object, msg: string) => void };
}

/**
 * The package's `drizzle/` directory, found by walking up from this module.
 * Works from `src/db/` under tsx and from `dist/src/db/` in the image, where
 * the Dockerfile copies `drizzle/` next to `dist/`; `process.cwd()` would
 * have tied the lookup to where the process happened to be started.
 */
export function defaultMigrationsFolder(from: string = fileURLToPath(import.meta.url)): string {
    let dir = dirname(from);
    for (let depth = 0; depth < 6; depth++) {
        const candidate = join(dir, "drizzle");
        if (existsSync(join(candidate, "meta", "_journal.json"))) return candidate;
        const parent = resolve(dir, "..");
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(`could not find a drizzle/ migrations directory above ${dirname(from)}`);
}

/**
 * Apply every pending migration, under the advisory lock. Resolves when the
 * chain is fully applied — whether by this call or by the replica that held
 * the lock first. Throws on a failed migration; the caller decides whether
 * that is fatal (it is, at boot).
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
    const folder = options.migrationsFolder ?? defaultMigrationsFolder();
    const sql = postgres(options.url, {
        max: 1,
        // The replica that lost the race sees `CREATE SCHEMA IF NOT EXISTS`
        // and `CREATE TABLE IF NOT EXISTS` notices from the journal setup;
        // they are not news and would print as raw objects on stdout.
        onnotice: () => {},
        ...(options.caCert ? { ssl: { rejectUnauthorized: true, ca: options.caCert } } : {}),
    });
    try {
        await sql`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
        try {
            await migrate(drizzle(sql), { migrationsFolder: folder });
        } finally {
            await sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
        }
    } finally {
        await sql.end();
    }
}
