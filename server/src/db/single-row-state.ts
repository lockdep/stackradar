/**
 * The single-row state tables of the column-update feed syncs
 * (`epss_sync_state`, `kev_sync_state`, `artifact_hub_sync_state`): one row,
 * `id` constant 1, written by upsert so the first run creates it and every
 * later run updates it.
 *
 * `osv_sync_state` is not written through here — its state machine (watermark,
 * generation pointer, initialized flag) has its own module in
 * `osv-sync/state.ts`.
 */

import type { InferInsertModel } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Logger } from "pino";
import { db } from "./index.js";

type SingleRowStateTable = PgTable & {
    id: AnyPgColumn;
    lastError: AnyPgColumn;
    updatedAt: AnyPgColumn;
};

/** Upsert the state row: insert `{ id: 1, ...values }`, or update `values` plus `updatedAt`. */
export async function upsertState<T extends SingleRowStateTable>(
    table: T,
    values: Partial<Omit<InferInsertModel<T>, "id" | "updatedAt">>
): Promise<void> {
    await db
        .insert(table)
        .values({ id: 1, ...values } as InferInsertModel<T>)
        .onConflictDoUpdate({
            target: table.id,
            set: { ...values, updatedAt: new Date() },
        });
}

/**
 * Record a failed run.
 *
 * Note this does *not* touch `lastSyncedAt`: the freshness guard has to keep
 * letting a retry through, and the freshness the API reports has to keep
 * ageing. A failed run is not a sync.
 */
export async function recordStateFailure(
    table: SingleRowStateTable,
    message: string
): Promise<void> {
    await upsertState(table, {
        lastError: message.slice(0, 2000),
    } as Partial<InferInsertModel<SingleRowStateTable>>);
}

/**
 * The freshness guard shared by the feed syncs: true when the last successful
 * run is recent enough that this one should skip. The feeds move about once a
 * day, so re-running sooner re-downloads megabytes to write the same values —
 * but `force` and an interval of 0 both disable the guard, because "run it
 * anyway" must stay one flag away for recovery.
 */
export async function isStateFresh(options: {
    force?: boolean | undefined;
    minSyncIntervalHours: number;
    getState: () => Promise<{ lastSyncedAt: Date | null } | undefined>;
    log: Logger;
    /** The log line for a skip, e.g. "EPSS scores are fresh, skipping". */
    message: string;
}): Promise<boolean> {
    if (options.force || options.minSyncIntervalHours <= 0) return false;
    const state = await options.getState();
    const last = state?.lastSyncedAt;
    if (!last) return false;
    const hours = (Date.now() - last.getTime()) / 3_600_000;
    if (hours >= options.minSyncIntervalHours) return false;
    options.log.info({ hoursSinceLastSync: Number(hours.toFixed(1)) }, options.message);
    return true;
}
