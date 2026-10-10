/**
 * Affected Package Repository
 *
 * Write-side database operations for the vulnerability_affected_packages
 * table: batch insert/replace for the sync paths and generation management.
 * Match-time reads live in matching/store.ts, keyed on match_key — nothing
 * queries this table by PURL any more.
 */

import { sql, eq, and, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../db/schema/index.js";
import type { Transaction } from "../db/index.js";
import {
    vulnerabilityAffectedPackages,
    type NewVulnerabilityAffectedPackage,
} from "../db/schema/vulnerabilities.js";
import { osvSyncState } from "../db/schema/osv-mirror.js";
import { isCurrentGeneration } from "../db/generation.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:affected-pkg-repo");

export interface OsvAffectedPackageRepository {
    /**
     * Replace all affected packages for a set of vulnerability UUIDs, within a
     * single generation. Deletes existing rows then bulk inserts new ones in a
     * transaction. Both halves are scoped to `generation`, so an incremental
     * sync can never disturb rows a bootstrap is building under another one.
     */
    replaceForVulns(
        vulnerabilityIds: string[],
        rows: NewVulnerabilityAffectedPackage[],
        generation: number
    ): Promise<{ deleted: number; inserted: number }>;

    /**
     * Bulk insert affected packages under a generation (used during a rebuild).
     * Does NOT delete existing rows — the generation swap handles cleanup.
     */
    bulkInsert(rows: NewVulnerabilityAffectedPackage[], generation: number): Promise<number>;

    /**
     * Delete all affected packages for the given vulnerability UUIDs.
     */
    deleteByVulnIds(vulnerabilityIds: string[]): Promise<number>;

    /**
     * Read the live generation pointer from osv_sync_state.
     */
    getCurrentGeneration(): Promise<number>;

    /**
     * Publish a freshly built generation: move the pointer and drop every row
     * belonging to any other generation, in one transaction. Until this runs,
     * readers keep seeing the previous generation.
     */
    promoteGeneration(generation: number): Promise<{ deleted: number }>;

    /**
     * Drop a half-built generation left behind by a failed rebuild. Refuses to
     * touch the live one.
     */
    discardGeneration(generation: number): Promise<number>;

    /**
     * Delete ALL rows, every generation. Test/maintenance helper — the sync
     * itself never truncates, that is the whole point of generations.
     */
    truncate(): Promise<void>;

    /**
     * Count of affected package rows in the live generation.
     */
    getCount(): Promise<number>;

    /**
     * Which of these vulnerabilities currently record any fixed version, in
     * the given generation. Read by the incremental sync *before* it replaces
     * an advisory's rows, so a none → some transition — a fix landing — is
     * observable at the moment the update is committed rather than by a
     * separate poll (the `issue.fix-available` hook, issues-workflow.md
     * phase 3).
     */
    vulnsWithFixedVersion(vulnerabilityIds: string[], generation: number): Promise<Set<string>>;
}

async function bulkInsertImpl(
    dbOrTx: PostgresJsDatabase<typeof schema> | Transaction,
    rows: NewVulnerabilityAffectedPackage[],
    generation: number
): Promise<number> {
    if (rows.length === 0) return 0;

    const CHUNK_SIZE = 500;
    let totalInserted = 0;

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const rowChunk = rows.slice(i, i + CHUNK_SIZE);
        const chunkValues = rowChunk.map((row) => {
            const versionsJson = row.versions ? JSON.stringify(row.versions) : null;
            const rangesJson = row.ranges ? JSON.stringify(row.ranges) : null;

            return sql`(
                ${row.vulnerabilityId},
                ${row.ecosystem ?? null},
                ${row.ecosystemFamily ?? null},
                ${row.ecosystemRelease ?? null},
                ${row.releaseVersion ?? null},
                ${row.packageName},
                ${row.purl ?? null},
                ${row.matchKey},
                ${row.withdrawn ?? false},
                ${versionsJson}::jsonb,
                ${rangesJson}::jsonb,
                ${row.fixedVersion ?? null},
                ${generation}
            )`;
        });

        await dbOrTx.execute(sql`
            INSERT INTO vulnerability_affected_packages (
                vulnerability_id, ecosystem, ecosystem_family, ecosystem_release, release_version, package_name,
                purl, match_key, withdrawn,
                versions, ranges, fixed_version, generation
            )
            VALUES ${sql.join(chunkValues, sql`, `)}
        `);
        totalInserted += rowChunk.length;
    }

    return totalInserted;
}

export function createOsvAffectedPackageRepository(
    db: PostgresJsDatabase<typeof schema>
): OsvAffectedPackageRepository {
    return {
        async replaceForVulns(
            vulnerabilityIds: string[],
            rows: NewVulnerabilityAffectedPackage[],
            generation: number
        ): Promise<{ deleted: number; inserted: number }> {
            if (vulnerabilityIds.length === 0) return { deleted: 0, inserted: 0 };

            return db.transaction(async (tx) => {
                const deletedRows = await tx
                    .delete(vulnerabilityAffectedPackages)
                    .where(
                        and(
                            inArray(vulnerabilityAffectedPackages.vulnerabilityId, vulnerabilityIds),
                            eq(vulnerabilityAffectedPackages.generation, generation)
                        )
                    )
                    .returning({ id: vulnerabilityAffectedPackages.id });
                const inserted = await bulkInsertImpl(tx, rows, generation);
                return { deleted: deletedRows.length, inserted };
            });
        },

        async bulkInsert(rows: NewVulnerabilityAffectedPackage[], generation: number): Promise<number> {
            return bulkInsertImpl(db, rows, generation);
        },

        async deleteByVulnIds(vulnerabilityIds: string[]): Promise<number> {
            if (vulnerabilityIds.length === 0) return 0;

            const deleted = await db
                .delete(vulnerabilityAffectedPackages)
                .where(inArray(vulnerabilityAffectedPackages.vulnerabilityId, vulnerabilityIds))
                .returning({ id: vulnerabilityAffectedPackages.id });
            return deleted.length;
        },

        async getCurrentGeneration(): Promise<number> {
            const [row] = await db
                .select({ generation: osvSyncState.affectedPkgGeneration })
                .from(osvSyncState)
                .where(eq(osvSyncState.id, 1))
                .limit(1);
            // No state row yet means nothing has ever synced; generation 1 is the
            // column default, so that is what an untouched table holds.
            return row?.generation ?? 1;
        },

        async promoteGeneration(generation: number): Promise<{ deleted: number }> {
            // Pointer move and old-row deletion in one transaction: a reader
            // either sees the whole previous generation or the whole new one.
            // Ordering within the transaction is irrelevant to readers for the
            // same reason, but the pointer is moved first so that the (long)
            // delete is not what other statements queue behind.
            return db.transaction(async (tx) => {
                await tx
                    .update(osvSyncState)
                    .set({ affectedPkgGeneration: generation, updatedAt: new Date() })
                    .where(eq(osvSyncState.id, 1));

                const deleted = await tx.execute<{ count: string }>(sql`
                    WITH removed AS (
                        DELETE FROM vulnerability_affected_packages
                        WHERE generation <> ${generation}
                        RETURNING 1
                    )
                    SELECT COUNT(*)::int AS count FROM removed
                `);

                const deletedCount = Number(deleted[0]?.count ?? 0);
                log.info({ generation, deleted: deletedCount }, "Promoted affected-package generation");
                return { deleted: deletedCount };
            });
        },

        async discardGeneration(generation: number): Promise<number> {
            const [state] = await db
                .select({ generation: osvSyncState.affectedPkgGeneration })
                .from(osvSyncState)
                .where(eq(osvSyncState.id, 1))
                .limit(1);

            if ((state?.generation ?? 1) === generation) {
                throw new Error(
                    `Refusing to discard generation ${generation}: it is the live one`
                );
            }

            const result = await db.execute<{ count: string }>(sql`
                WITH removed AS (
                    DELETE FROM vulnerability_affected_packages
                    WHERE generation = ${generation}
                    RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM removed
            `);
            const deleted = Number(result[0]?.count ?? 0);
            log.info({ generation, deleted }, "Discarded affected-package generation");
            return deleted;
        },

        async truncate(): Promise<void> {
            await db.execute(sql`TRUNCATE TABLE vulnerability_affected_packages`);
            log.info("Truncated vulnerability_affected_packages table");
        },

        async vulnsWithFixedVersion(
            vulnerabilityIds: string[],
            generation: number
        ): Promise<Set<string>> {
            if (vulnerabilityIds.length === 0) return new Set();
            const rows = await db
                .selectDistinct({ vulnerabilityId: vulnerabilityAffectedPackages.vulnerabilityId })
                .from(vulnerabilityAffectedPackages)
                .where(
                    and(
                        inArray(vulnerabilityAffectedPackages.vulnerabilityId, vulnerabilityIds),
                        eq(vulnerabilityAffectedPackages.generation, generation),
                        sql`${vulnerabilityAffectedPackages.fixedVersion} IS NOT NULL`,
                        eq(vulnerabilityAffectedPackages.withdrawn, false)
                    )
                );
            return new Set(rows.map((r) => r.vulnerabilityId));
        },

        async getCount(): Promise<number> {
            // Live generation only — during a rebuild the raw table count is
            // roughly double and says nothing about what matching can see.
            const result = await db.execute<{ count: string }>(
                sql`SELECT COUNT(*)::int AS count FROM vulnerability_affected_packages
                    WHERE ${isCurrentGeneration()}`
            );
            return parseInt(result[0]?.count ?? "0", 10);
        },
    };
}
