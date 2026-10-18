/**
 * OSV Sync State Management
 *
 * Handles reading and updating the sync state in the database.
 * Ensures the state row exists and provides typed access to state fields.
 */

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import type * as schema from "../db/schema/index.js";
import { osvSyncState, type OsvSyncState, type OsvSyncStateUpdate, type SyncStatus } from "../db/schema/osv-mirror.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:state");

/**
 * A watermark may never run ahead of the clock that set it.
 *
 * OSV serves records whose `modified` is in the future: RustSec stamps noon
 * of the advisory's date, so `RUSTSEC-2021-0046`, touched on 2026-08-29,
 * carried `modified: 2026-08-29T12:00:00Z` and was mirrored by the 07:00
 * sync. Applied verbatim as `last_modified_applied`, that one record froze
 * the mirror for five hours: every later run cut the modified list off at
 * "11:50 today", saw only that record, reported the mirror unchanged, queued
 * no rescans, and told the UI its data was "as of just now". Clamping to the
 * moment of writing costs a re-fetch of the future-dated record each cycle
 * (it hashes unchanged and is skipped) and nothing else.
 */
export function clampWatermark(candidate: Date, now: Date = new Date()): Date {
    if (candidate <= now) return candidate;
    // Loud on purpose: the freeze this guards against reported "success,
    // 0 updated, lag 0" every hour. A future `modified` should be visible
    // in the logs the first time it arrives, not inferred five hours later.
    log.warn(
        { candidate, now, aheadSeconds: Math.round((candidate.getTime() - now.getTime()) / 1000) },
        "Watermark ahead of the clock — clamped to now (a record with a future OSV `modified`)",
    );
    return now;
}

export interface SyncStateManager {
    /**
     * Ensure the sync state row exists (insert if missing)
     */
    ensureInitialized(): Promise<void>;

    /**
     * Get the current sync state
     */
    getState(): Promise<OsvSyncState>;

    /**
     * Update specific fields of the sync state
     */
    updateState(update: OsvSyncStateUpdate): Promise<void>;

    /**
     * Mark initialization as complete, recording which ecosystems the
     * published generation carries (`null` = the whole corpus).
     */
    markInitialized(maxModifiedTimestamp: Date, ecosystems: string[] | null): Promise<void>;

    /**
     * Record a successful incremental sync
     */
    recordSuccessfulSync(params: { pollTime: Date; maxModifiedSeen: Date; maxModifiedApplied: Date }): Promise<void>;

    /**
     * Record a failure
     */
    recordFailure(errorMessage: string): Promise<void>;

    /**
     * Get the lag in seconds between what OSV has and what we've applied
     */
    getLagSeconds(): Promise<number | null>;

    /**
     * Set the current sync status (idle, full_refresh, incremental).
     * Should be set at the start of a sync and cleared to "idle" when done.
     * Leaving `full_refresh` also drops `bootstrap_progress`: a snapshot of a
     * run that has ended is a lie the banner would keep repeating.
     */
    setSyncStatus(status: SyncStatus): Promise<void>;

    /**
     * Get the current sync status.
     *
     * No production caller — the admin surface reads osv_sync_state directly.
     * Kept as the probe `tests/unit/osv-sync/mirror-read-guard.test.ts` uses
     * to observe the status transitions `setSyncStatus` writes.
     */
    getSyncStatus(): Promise<SyncStatus>;

    /**
     * Try to acquire the advisory lock for exclusive access
     * Returns true if lock acquired, false if another instance holds it
     */
    tryAcquireAdvisoryLock(lockId: number): Promise<boolean>;

    /**
     * Release the advisory lock
     */
    releaseAdvisoryLock(lockId: number): Promise<void>;
}

export function createSyncStateManager(
    db: PostgresJsDatabase<typeof schema>,
    pgClient: postgres.Sql,
): SyncStateManager {
    // Session-level advisory locks are tied to a specific connection. With a
    // connection pool, acquire and release can land on different connections,
    // making the release a no-op. A reserved connection guarantees both calls
    // run on the same physical connection.
    let reservedConn: postgres.ReservedSql | null = null;

    return {
        async ensureInitialized(): Promise<void> {
            // Use INSERT ... ON CONFLICT DO NOTHING to ensure row exists
            await db.insert(osvSyncState).values({ id: 1 }).onConflictDoNothing({ target: osvSyncState.id });
        },

        async getState(): Promise<OsvSyncState> {
            const [state] = await db.select().from(osvSyncState).where(eq(osvSyncState.id, 1)).limit(1);

            if (!state) {
                throw new Error("Sync state not initialized. Call ensureInitialized() first.");
            }

            return state;
        },

        async updateState(update: OsvSyncStateUpdate): Promise<void> {
            const now = new Date();
            const clamped = { ...update };
            if (clamped.lastModifiedApplied)
                clamped.lastModifiedApplied = clampWatermark(clamped.lastModifiedApplied, now);
            if (clamped.lastModifiedSeen) clamped.lastModifiedSeen = clampWatermark(clamped.lastModifiedSeen, now);
            await db
                .update(osvSyncState)
                .set({
                    ...clamped,
                    updatedAt: now,
                })
                .where(eq(osvSyncState.id, 1));
        },

        async markInitialized(maxModifiedTimestamp: Date, ecosystems: string[] | null): Promise<void> {
            const now = new Date();
            await db
                .update(osvSyncState)
                .set({
                    initialized: true,
                    initCompletedAt: now,
                    lastFullRefreshAt: now,
                    lastModifiedApplied: clampWatermark(maxModifiedTimestamp, now),
                    ecosystems,
                    syncStatus: "idle",
                    bootstrapProgress: null,
                    consecutiveFailures: 0,
                    lastError: null,
                    updatedAt: now,
                })
                .where(eq(osvSyncState.id, 1));
        },

        async recordSuccessfulSync(params): Promise<void> {
            const now = new Date();
            await db
                .update(osvSyncState)
                .set({
                    lastSuccessfulPollAt: params.pollTime,
                    lastModifiedSeen: clampWatermark(params.maxModifiedSeen, now),
                    lastModifiedApplied: clampWatermark(params.maxModifiedApplied, now),
                    consecutiveFailures: 0,
                    lastError: null,
                    updatedAt: now,
                })
                .where(eq(osvSyncState.id, 1));
        },

        async recordFailure(errorMessage: string): Promise<void> {
            await db
                .update(osvSyncState)
                .set({
                    consecutiveFailures: sql`${osvSyncState.consecutiveFailures} + 1`,
                    lastError: errorMessage,
                    updatedAt: new Date(),
                })
                .where(eq(osvSyncState.id, 1));
        },

        async getLagSeconds(): Promise<number | null> {
            const state = await this.getState();

            if (!state.lastModifiedSeen || !state.lastModifiedApplied) {
                return null;
            }

            const seenMs = state.lastModifiedSeen.getTime();
            const appliedMs = state.lastModifiedApplied.getTime();

            return Math.max(0, Math.floor((seenMs - appliedMs) / 1000));
        },

        async setSyncStatus(status: SyncStatus): Promise<void> {
            await db
                .update(osvSyncState)
                .set({
                    syncStatus: status,
                    ...(status !== "full_refresh" && { bootstrapProgress: null }),
                    updatedAt: new Date(),
                })
                .where(eq(osvSyncState.id, 1));
        },

        async getSyncStatus(): Promise<SyncStatus> {
            const state = await this.getState();
            return (state.syncStatus as SyncStatus) ?? "idle";
        },

        async tryAcquireAdvisoryLock(lockId: number): Promise<boolean> {
            const reserved = await pgClient.reserve();
            const result = await reserved<[{ pg_try_advisory_lock: boolean }]>`
                SELECT pg_try_advisory_lock(${lockId})
            `;
            if (result[0]?.pg_try_advisory_lock) {
                reservedConn = reserved;
                return true;
            }
            reserved.release();
            return false;
        },

        async releaseAdvisoryLock(lockId: number): Promise<void> {
            if (!reservedConn) return;
            try {
                await reservedConn`SELECT pg_advisory_unlock(${lockId})`;
            } finally {
                reservedConn.release();
                reservedConn = null;
            }
        },
    };
}
