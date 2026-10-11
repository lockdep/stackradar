import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMigrationsFolder, MIGRATION_LOCK_KEY, runMigrations } from "../../../src/db/migrate.js";
import { getTestPgClient } from "../../setup/test-db.js";

/**
 * Step 05 acceptance: an empty database, `MIGRATE_ON_START=true`, two
 * replicas starting together — both come up, the chain ran once, and a
 * later start is a no-op. Runs against its own database on the shared
 * container so the suite's migrated `test_server` is never touched.
 */

const DB_NAME = "migrate_on_start_test";

function withDatabase(url: string, name: string): string {
    const u = new URL(url);
    u.pathname = `/${name}`;
    return u.toString();
}

describe("runMigrations", () => {
    let adminUrl: string;
    let targetUrl: string;

    beforeAll(async () => {
        adminUrl = process.env.DATABASE_URL!;
        targetUrl = withDatabase(adminUrl, DB_NAME);
        const admin = getTestPgClient();
        await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME}`);
        await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
    });

    afterAll(async () => {
        const admin = getTestPgClient();
        await admin.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    });

    it("finds the package's drizzle/ directory from src/", () => {
        const folder = defaultMigrationsFolder();
        expect(folder.endsWith("/server/drizzle")).toBe(true);
    });

    it("two concurrent starts both complete and the chain runs exactly once; a third is a no-op", async () => {
        await Promise.all([runMigrations({ url: targetUrl }), runMigrations({ url: targetUrl })]);

        const sql = postgres(targetUrl, { max: 1 });
        try {
            const journal = JSON.parse(
                readFileSync(join(defaultMigrationsFolder(), "meta", "_journal.json"), "utf8"),
            ) as { entries: unknown[] };

            const [{ count }] = await sql<[{ count: string }]>`
                SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations
            `;
            expect(Number(count)).toBe(journal.entries.length);

            const tables = await sql<{ table_name: string }[]>`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public' AND table_name IN ('images', 'sboms', 'organizations', 'users')
            `;
            expect(tables.map((t) => t.table_name).sort()).toEqual(["images", "organizations", "sboms", "users"]);

            // The lock is released: nobody is left holding it after the run.
            const [{ held }] = await sql<[{ held: boolean }]>`
                SELECT EXISTS (
                    SELECT 1 FROM pg_locks
                    WHERE locktype = 'advisory' AND granted
                      AND ((classid::bigint << 32) | objid::bigint) = ${MIGRATION_LOCK_KEY}
                ) AS held
            `;
            expect(held).toBe(false);

            await runMigrations({ url: targetUrl });
            const [{ again }] = await sql<[{ again: string }]>`
                SELECT count(*)::text AS again FROM drizzle.__drizzle_migrations
            `;
            expect(Number(again)).toBe(journal.entries.length);
        } finally {
            await sql.end();
        }
    });

    it("waits for a lock held elsewhere instead of racing past it", async () => {
        const holder = postgres(targetUrl, { max: 1 });
        try {
            await holder`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
            let settled = false;
            const run = runMigrations({ url: targetUrl }).then(() => {
                settled = true;
            });
            await new Promise((r) => setTimeout(r, 300));
            expect(settled).toBe(false);
            await holder`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
            await run;
            expect(settled).toBe(true);
        } finally {
            await holder.end();
        }
    });
});
