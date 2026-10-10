/**
 * OSV Sync Failure Repository
 *
 * Records OSV entries that failed to parse or download during sync runs, and
 * sweeps old ones. Reads of the failures table happen in `admin.repository.ts`,
 * which queries it directly.
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../db/schema/index.js";
import { type NewOsvSyncFailure } from "../db/schema/osv-mirror.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:failure-repository");

export interface OsvSyncFailureRepository {
    /**
     * Bulk-insert failure records.
     * Callers accumulate failures in a buffer and flush periodically.
     */
    bulkInsert(records: NewOsvSyncFailure[]): Promise<number>;

    /**
     * Delete failures older than the given date.
     */
    deleteOlderThan(date: Date): Promise<number>;

    /**
     * Get total failure count across all runs.
     */
    getCount(): Promise<number>;
}

export function createOsvSyncFailureRepository(
    db: PostgresJsDatabase<typeof schema>
): OsvSyncFailureRepository {
    return {
        async bulkInsert(records: NewOsvSyncFailure[]): Promise<number> {
            if (records.length === 0) return 0;

            const CHUNK_SIZE = 500;
            const MAX_MSG_LEN = 8192;

            for (let i = 0; i < records.length; i += CHUNK_SIZE) {
                const chunk = records.slice(i, i + CHUNK_SIZE);
                const valuesList = chunk.map((r) =>
                    sql`(
                        ${r.syncRunId},
                        ${r.syncMode},
                        ${r.osvId ?? null},
                        ${r.ecosystemDir ?? null},
                        ${r.sourcePath},
                        ${r.errorType},
                        ${r.errorMessage.length > MAX_MSG_LEN ? r.errorMessage.slice(0, MAX_MSG_LEN) + "…" : r.errorMessage},
                        NOW()
                    )`
                );

                await db.execute(sql`
                    INSERT INTO osv_sync_failures
                        (sync_run_id, sync_mode, osv_id, ecosystem_dir, source_path, error_type, error_message, occurred_at)
                    VALUES ${sql.join(valuesList, sql`, `)}
                `);
            }

            // Split in the log line, not just at the read side: this table holds
            // ingested-but-deviating records alongside dropped ones, and a bare
            // total under the word "failures" reads as data loss when it is
            // usually all warnings.
            const warnings = records.filter((r) => r.errorType === "validation_warning").length;
            log.info(
                { count: records.length, warnings, failures: records.length - warnings },
                "Bulk-inserted sync failures and warnings"
            );
            return records.length;
        },

        async deleteOlderThan(date: Date): Promise<number> {
            // Counted by the statement rather than by RETURNING rows: a first
            // sweep after months of accumulation can delete six figures of them,
            // and none of that data is wanted back.
            const result = await db.execute<{ count: string }>(sql`
                WITH removed AS (
                    DELETE FROM osv_sync_failures
                    WHERE occurred_at < ${date.toISOString()}::timestamptz
                    RETURNING 1
                )
                SELECT COUNT(*)::int AS count FROM removed
            `);

            const count = Number(result[0]?.count ?? 0);
            if (count > 0) {
                log.info({ olderThan: date.toISOString(), deleted: count }, "Cleaned up old sync failures");
            }
            return count;
        },

        async getCount(): Promise<number> {
            const result = await db.execute<{ count: string }>(
                sql`SELECT COUNT(*)::int AS count FROM osv_sync_failures`
            );
            return parseInt(result[0]?.count ?? "0", 10);
        },
    };
}
