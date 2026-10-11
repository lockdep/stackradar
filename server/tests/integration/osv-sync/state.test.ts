import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import { getTestDb, getTestPgClient } from "../../setup/test-db.js";
import { createSyncStateManager, type SyncStateManager } from "../../../src/osv-sync/state.js";

describe("SyncStateManager", () => {
    let db: ReturnType<typeof getTestDb>;
    let stateManager: SyncStateManager;

    beforeAll(() => {
        db = getTestDb();
        stateManager = createSyncStateManager(db, getTestPgClient());
    });

    beforeEach(async () => {
        await db.execute(sql`TRUNCATE TABLE osv_sync_state`);
    });

    describe("ensureInitialized", () => {
        it("should create the state row if it does not exist", async () => {
            await stateManager.ensureInitialized();

            const state = await stateManager.getState();
            expect(state).not.toBeNull();
            expect(state.id).toBe(1);
            expect(state.initialized).toBe(false);
            expect(state.consecutiveFailures).toBe(0);
        });

        it("should be idempotent (not fail if row exists)", async () => {
            await stateManager.ensureInitialized();
            await stateManager.ensureInitialized();
            await stateManager.ensureInitialized();

            // Should still have only one row with id=1
            const result = await db.execute<{ count: string }>(sql`SELECT COUNT(*) as count FROM osv_sync_state`);
            expect(parseInt(result[0]?.count ?? "0", 10)).toBe(1);
        });
    });

    describe("getState", () => {
        it("should throw if state not initialized", async () => {
            await expect(stateManager.getState()).rejects.toThrow("not initialized");
        });

        it("should return the current state", async () => {
            await stateManager.ensureInitialized();

            const state = await stateManager.getState();

            expect(state.initialized).toBe(false);
            expect(state.consecutiveFailures).toBe(0);
            expect(state.lastError).toBeNull();
        });
    });

    describe("updateState", () => {
        it("should update specific fields", async () => {
            await stateManager.ensureInitialized();

            await stateManager.updateState({
                initialized: true,
                consecutiveFailures: 5,
            });

            const state = await stateManager.getState();
            expect(state.initialized).toBe(true);
            expect(state.consecutiveFailures).toBe(5);
        });

        it("should update the updatedAt timestamp", async () => {
            await stateManager.ensureInitialized();
            const initialState = await stateManager.getState();

            // Wait a bit to ensure timestamp difference
            await new Promise((resolve) => setTimeout(resolve, 10));

            await stateManager.updateState({ consecutiveFailures: 1 });

            const updatedState = await stateManager.getState();
            expect(updatedState.updatedAt.getTime()).toBeGreaterThan(initialState.updatedAt.getTime());
        });
    });

    describe("markInitialized", () => {
        it("should mark the state as initialized with timestamps", async () => {
            await stateManager.ensureInitialized();
            const maxModified = new Date("2024-01-15T12:00:00Z");

            await stateManager.markInitialized(maxModified, null);

            const state = await stateManager.getState();
            expect(state.initialized).toBe(true);
            expect(state.initCompletedAt).not.toBeNull();
            expect(state.lastFullRefreshAt).not.toBeNull();
            expect(state.lastModifiedApplied?.toISOString()).toBe(maxModified.toISOString());
            expect(state.consecutiveFailures).toBe(0);
            expect(state.lastError).toBeNull();
        });
    });

    describe("recordSuccessfulSync", () => {
        it("should update sync timestamps and reset failures", async () => {
            await stateManager.ensureInitialized();
            // First record a failure
            await stateManager.recordFailure("Some error");

            const pollTime = new Date("2024-01-15T12:00:00Z");
            const maxSeen = new Date("2024-01-15T11:55:00Z");
            const maxApplied = new Date("2024-01-15T11:50:00Z");

            await stateManager.recordSuccessfulSync({
                pollTime,
                maxModifiedSeen: maxSeen,
                maxModifiedApplied: maxApplied,
            });

            const state = await stateManager.getState();
            expect(state.lastSuccessfulPollAt?.toISOString()).toBe(pollTime.toISOString());
            expect(state.lastModifiedSeen?.toISOString()).toBe(maxSeen.toISOString());
            expect(state.lastModifiedApplied?.toISOString()).toBe(maxApplied.toISOString());
            expect(state.consecutiveFailures).toBe(0);
            expect(state.lastError).toBeNull();
        });
    });

    // The RUSTSEC-2021-0046 incident: a record whose OSV `modified` was noon
    // today, mirrored at 07:00, froze the mirror until noon.
    describe("watermarks never run ahead of the clock", () => {
        const future = () => new Date(Date.now() + 3 * 60 * 60 * 1000);
        const past = new Date("2026-08-29T07:00:00Z");

        it("recordSuccessfulSync clamps a future watermark to now", async () => {
            await stateManager.ensureInitialized();
            const before = new Date();
            await stateManager.recordSuccessfulSync({
                pollTime: before,
                maxModifiedSeen: future(),
                maxModifiedApplied: future(),
            });
            const state = await stateManager.getState();
            expect(state.lastModifiedApplied!.getTime()).toBeLessThanOrEqual(Date.now());
            expect(state.lastModifiedApplied!.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(state.lastModifiedSeen!.getTime()).toBeLessThanOrEqual(Date.now());
        });

        it("recordSuccessfulSync stores a past watermark verbatim", async () => {
            await stateManager.ensureInitialized();
            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: past,
                maxModifiedApplied: past,
            });
            const state = await stateManager.getState();
            expect(state.lastModifiedApplied).toEqual(past);
        });

        it("updateState clamps a future chunk checkpoint", async () => {
            await stateManager.ensureInitialized();
            await stateManager.updateState({ lastModifiedApplied: future() });
            const state = await stateManager.getState();
            expect(state.lastModifiedApplied!.getTime()).toBeLessThanOrEqual(Date.now());
        });

        it("markInitialized clamps a future bootstrap maximum", async () => {
            await stateManager.ensureInitialized();
            await stateManager.markInitialized(future(), null);
            const state = await stateManager.getState();
            expect(state.lastModifiedApplied!.getTime()).toBeLessThanOrEqual(Date.now());
            expect(state.initialized).toBe(true);
        });
    });

    describe("recordFailure", () => {
        it("should increment consecutive failures and record error", async () => {
            await stateManager.ensureInitialized();

            await stateManager.recordFailure("First error");

            let state = await stateManager.getState();
            expect(state.consecutiveFailures).toBe(1);
            expect(state.lastError).toBe("First error");

            await stateManager.recordFailure("Second error");

            state = await stateManager.getState();
            expect(state.consecutiveFailures).toBe(2);
            expect(state.lastError).toBe("Second error");
        });
    });

    describe("getLagSeconds", () => {
        it("should return null when timestamps are not set", async () => {
            await stateManager.ensureInitialized();

            const lag = await stateManager.getLagSeconds();

            expect(lag).toBeNull();
        });

        it("should return lag in seconds", async () => {
            await stateManager.ensureInitialized();

            // Seen is 10 minutes ahead of applied
            const maxSeen = new Date("2024-01-15T12:10:00Z");
            const maxApplied = new Date("2024-01-15T12:00:00Z");

            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: maxSeen,
                maxModifiedApplied: maxApplied,
            });

            const lag = await stateManager.getLagSeconds();

            expect(lag).toBe(600); // 10 minutes = 600 seconds
        });

        it("should return 0 when applied equals seen", async () => {
            await stateManager.ensureInitialized();

            const timestamp = new Date("2024-01-15T12:00:00Z");

            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: timestamp,
                maxModifiedApplied: timestamp,
            });

            const lag = await stateManager.getLagSeconds();

            expect(lag).toBe(0);
        });

        it("should return 0 when applied is ahead of seen (edge case)", async () => {
            await stateManager.ensureInitialized();

            // Edge case: applied is somehow ahead (shouldn't happen normally)
            const maxSeen = new Date("2024-01-15T12:00:00Z");
            const maxApplied = new Date("2024-01-15T12:10:00Z");

            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: maxSeen,
                maxModifiedApplied: maxApplied,
            });

            const lag = await stateManager.getLagSeconds();

            expect(lag).toBe(0);
        });
    });

    describe("advisory locks", () => {
        it("should acquire and release advisory lock", async () => {
            const lockId = 12345;

            // Acquire lock
            const acquired = await stateManager.tryAcquireAdvisoryLock(lockId);
            expect(acquired).toBe(true);

            // Release lock
            await stateManager.releaseAdvisoryLock(lockId);
        });

        it("should fail to acquire lock if already held (different session)", async () => {
            const lockId = 12346;

            // Acquire lock first time
            const acquired1 = await stateManager.tryAcquireAdvisoryLock(lockId);
            expect(acquired1).toBe(true);

            // A second acquisition attempt opens a new reserved connection (new session).
            // pg_try_advisory_lock returns false when another session holds the lock.
            const acquired2 = await stateManager.tryAcquireAdvisoryLock(lockId);
            expect(acquired2).toBe(false);

            // Release the original lock (only one release needed)
            await stateManager.releaseAdvisoryLock(lockId);
        });
    });

    describe("syncStatus", () => {
        it("should default to 'idle' on fresh init", async () => {
            await stateManager.ensureInitialized();

            const status = await stateManager.getSyncStatus();
            expect(status).toBe("idle");
        });

        it("should set status to 'full_refresh'", async () => {
            await stateManager.ensureInitialized();

            await stateManager.setSyncStatus("full_refresh");

            const status = await stateManager.getSyncStatus();
            expect(status).toBe("full_refresh");
        });

        it("should set status to 'incremental'", async () => {
            await stateManager.ensureInitialized();

            await stateManager.setSyncStatus("incremental");

            const status = await stateManager.getSyncStatus();
            expect(status).toBe("incremental");
        });

        it("should reset status back to 'idle'", async () => {
            await stateManager.ensureInitialized();

            await stateManager.setSyncStatus("full_refresh");
            expect(await stateManager.getSyncStatus()).toBe("full_refresh");

            await stateManager.setSyncStatus("idle");
            expect(await stateManager.getSyncStatus()).toBe("idle");
        });

        it("should be visible in getState()", async () => {
            await stateManager.ensureInitialized();
            await stateManager.setSyncStatus("incremental");

            const state = await stateManager.getState();
            expect(state.syncStatus).toBe("incremental");
        });

        it("markInitialized should reset syncStatus to idle", async () => {
            await stateManager.ensureInitialized();
            await stateManager.setSyncStatus("full_refresh");

            await stateManager.markInitialized(new Date("2024-01-15T12:00:00Z"), null);

            const status = await stateManager.getSyncStatus();
            expect(status).toBe("idle");
        });
    });

    describe("watermark advancement", () => {
        it("should only advance watermark on successful sync", async () => {
            await stateManager.ensureInitialized();
            await stateManager.markInitialized(new Date("2024-01-15T10:00:00Z"), null);

            // Simulate a successful sync
            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: new Date("2024-01-15T12:00:00Z"),
                maxModifiedApplied: new Date("2024-01-15T11:00:00Z"),
            });

            let state = await stateManager.getState();
            expect(state.lastModifiedApplied?.toISOString()).toBe("2024-01-15T11:00:00.000Z");

            // Simulate a failure - watermark should not advance
            await stateManager.recordFailure("Network error");

            state = await stateManager.getState();
            // Watermark should still be at previous value
            expect(state.lastModifiedApplied?.toISOString()).toBe("2024-01-15T11:00:00.000Z");
        });

        it("should not regress watermark on subsequent syncs", async () => {
            await stateManager.ensureInitialized();
            await stateManager.markInitialized(new Date("2024-01-15T10:00:00Z"), null);

            // First sync advances to 11:00
            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: new Date("2024-01-15T12:00:00Z"),
                maxModifiedApplied: new Date("2024-01-15T11:00:00Z"),
            });

            // Second sync advances further to 11:30
            await stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen: new Date("2024-01-15T12:30:00Z"),
                maxModifiedApplied: new Date("2024-01-15T11:30:00Z"),
            });

            const state = await stateManager.getState();
            expect(state.lastModifiedApplied?.toISOString()).toBe("2024-01-15T11:30:00.000Z");
        });
    });
});
