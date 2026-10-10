/**
 * OSV Sync Run Repository
 *
 * Records completed OSV sync cycles (via `sync-utils.persistRun`). Reads of
 * the runs table happen in `admin.repository.ts`, which queries it directly.
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "../db/schema/index.js";
import { osvSyncRuns, type NewOsvSyncRun } from "../db/schema/osv-mirror.js";

export interface OsvSyncRunRepository {
    /**
     * Insert a completed sync run record.
     */
    insert(run: NewOsvSyncRun): Promise<void>;
}

export function createOsvSyncRunRepository(
    db: PostgresJsDatabase<typeof schema>
): OsvSyncRunRepository {
    return {
        async insert(run: NewOsvSyncRun): Promise<void> {
            await db.insert(osvSyncRuns).values(run);
        },
    };
}
