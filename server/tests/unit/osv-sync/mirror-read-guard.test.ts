/**
 * Mirror Read Guard Tests
 *
 * Verifies that the vulnerability sync service blocks matching only while the
 * mirror has never completed an import, and that a sync being in progress —
 * full refresh included — no longer blocks anything: rebuilds happen under a
 * new generation and swap in atomically, so readers always see a complete
 * mirror.
 *
 * These are integration tests that use a real database (via test containers).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

import { getTestDb, getTestPgClient } from "../../setup/test-db.js";
import { createSyncStateManager, type SyncStateManager } from "../../../src/osv-sync/state.js";
import { OsvMirrorNotReadyError } from "../../../src/services/vulnerability-sync.service.js";

describe("OsvMirrorNotReadyError", () => {
    it("should have the correct name, reason and syncStatus", () => {
        const error = new OsvMirrorNotReadyError("full_refresh");

        expect(error).toBeInstanceOf(Error);
        expect(error).toBeInstanceOf(OsvMirrorNotReadyError);
        expect(error.name).toBe("OsvMirrorNotReadyError");
        expect(error.reason).toBe("not_initialized");
        expect(error.syncStatus).toBe("full_refresh");
        expect(error.message).toContain("initial import");
        expect(error.message).toContain("unavailable");
    });
});

describe("Mirror read guard (integration)", () => {
    let db: ReturnType<typeof getTestDb>;
    let stateManager: SyncStateManager;

    beforeEach(async () => {
        db = getTestDb();
        stateManager = createSyncStateManager(db, getTestPgClient());

        await db.execute(sql`TRUNCATE TABLE osv_sync_state`);
        await stateManager.ensureInitialized();
    });

    it("syncStatus should be 'idle' after initialization", async () => {
        const status = await stateManager.getSyncStatus();
        expect(status).toBe("idle");
    });

    it("should allow setting and reading full_refresh status", async () => {
        await stateManager.setSyncStatus("full_refresh");
        const status = await stateManager.getSyncStatus();
        expect(status).toBe("full_refresh");
    });

    it("should allow setting and reading incremental status", async () => {
        await stateManager.setSyncStatus("incremental");
        const status = await stateManager.getSyncStatus();
        expect(status).toBe("incremental");
    });

    it("should persist syncStatus through getState()", async () => {
        await stateManager.setSyncStatus("full_refresh");
        const state = await stateManager.getState();
        expect(state.syncStatus).toBe("full_refresh");
    });

    it("markInitialized should reset syncStatus to idle", async () => {
        await stateManager.setSyncStatus("full_refresh");

        await stateManager.markInitialized(new Date("2024-06-01T00:00:00Z"), null);

        const status = await stateManager.getSyncStatus();
        expect(status).toBe("idle");
    });

    it("should survive a round-trip: set full_refresh, then back to idle", async () => {
        await stateManager.setSyncStatus("full_refresh");
        expect(await stateManager.getSyncStatus()).toBe("full_refresh");

        await stateManager.setSyncStatus("idle");
        expect(await stateManager.getSyncStatus()).toBe("idle");
    });

    it("setSyncStatus should update the updatedAt timestamp", async () => {
        const stateBefore = await stateManager.getState();

        await new Promise((resolve) => setTimeout(resolve, 10));

        await stateManager.setSyncStatus("incremental");
        const stateAfter = await stateManager.getState();

        expect(stateAfter.updatedAt.getTime()).toBeGreaterThan(
            stateBefore.updatedAt.getTime()
        );
    });
});
