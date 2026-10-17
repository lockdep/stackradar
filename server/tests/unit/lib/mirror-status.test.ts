import { describe, it, expect } from "vitest";
import { buildMirrorStatus } from "../../../src/lib/mirror-status.js";
import type { OsvSyncState } from "../../../src/db/schema/osv-mirror.js";
import type { epssSyncState, kevSyncState } from "../../../src/db/schema/threat-intel.js";

/**
 * The status rules behind the fresh-install banner. The three rows are what
 * the syncs write; what matters is that each feed's status reads as the
 * stage it is at, and that `ready` only flips once all three have landed.
 */

const NOW = new Date("2026-10-17T10:00:00Z");

function osv(overrides: Partial<OsvSyncState> = {}): OsvSyncState {
    return {
        id: 1,
        initialized: false,
        initCompletedAt: null,
        lastSuccessfulPollAt: null,
        lastModifiedSeen: null,
        lastModifiedApplied: null,
        lastFullRefreshAt: null,
        syncStatus: "idle",
        affectedPkgGeneration: 1,
        consecutiveFailures: 0,
        lastError: null,
        ecosystems: null,
        bootstrapProgress: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

type EpssRow = typeof epssSyncState.$inferSelect;
type KevRow = typeof kevSyncState.$inferSelect;

function epss(overrides: Partial<EpssRow> = {}): EpssRow {
    return {
        id: 1,
        lastSyncedAt: null,
        lastScoreDate: null,
        rowsInFile: null,
        rowsMatched: null,
        rowsUnmatched: null,
        lastError: null,
        runStartedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

function kev(overrides: Partial<KevRow> = {}): KevRow {
    return {
        id: 1,
        lastSyncedAt: null,
        catalogVersion: null,
        releasedAt: null,
        entriesInCatalog: null,
        entriesMatched: null,
        entriesCleared: null,
        lastError: null,
        runStartedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

const progress = {
    startedAt: "2026-10-17T09:50:00.000Z",
    updatedAt: "2026-10-17T09:59:00.000Z",
    archiveIndex: 2,
    archiveCount: 4,
    ecosystem: "Debian",
    phase: "importing" as const,
    bytesReceived: 1000,
    contentLength: 1000,
    recordsProcessed: 5000,
    archiveEntries: 12000,
    recordsFromEarlierArchives: 3000,
};

describe("buildMirrorStatus", () => {
    it("is all pending, and not ready, before any sync has written a row", () => {
        const status = buildMirrorStatus({ osv: null, epss: null, kev: null }, NOW);
        expect(status.ready).toBe(false);
        expect(status.osv.status).toBe("pending");
        expect(status.epss.status).toBe("pending");
        expect(status.kev.status).toBe("pending");
        expect(status.osv.bootstrap).toBeNull();
    });

    it("reports a running bootstrap with its progress", () => {
        const status = buildMirrorStatus(
            { osv: osv({ syncStatus: "full_refresh", bootstrapProgress: progress }), epss: null, kev: null },
            NOW,
        );
        expect(status.osv.status).toBe("running");
        expect(status.osv.bootstrap).toEqual(progress);
    });

    it("drops a progress snapshot the state row carries outside a running bootstrap", () => {
        // A crashed run leaves `sync_status` and the snapshot behind until the
        // next run resets them; the snapshot alone is not evidence of progress.
        const status = buildMirrorStatus(
            {
                osv: osv({ syncStatus: "idle", bootstrapProgress: progress, lastError: "killed" }),
                epss: null,
                kev: null,
            },
            NOW,
        );
        expect(status.osv.status).toBe("failed");
        expect(status.osv.bootstrap).toBeNull();
    });

    it("reports a failed first bootstrap, with its error, as failed rather than pending", () => {
        const status = buildMirrorStatus({ osv: osv({ lastError: "download stalled" }), epss: null, kev: null }, NOW);
        expect(status.osv.status).toBe("failed");
        expect(status.osv.lastError).toBe("download stalled");
    });

    it("reports a feed as running from its run stamp, and as failed once the stamp is cleared with an error", () => {
        const running = buildMirrorStatus(
            { osv: null, epss: epss({ runStartedAt: new Date("2026-10-17T09:58:00Z") }), kev: null },
            NOW,
        );
        expect(running.epss.status).toBe("running");
        expect(running.epss.runStartedAt).toBe("2026-10-17T09:58:00.000Z");

        const failed = buildMirrorStatus({ osv: null, epss: null, kev: kev({ lastError: "HTTP 503" }) }, NOW);
        expect(failed.kev.status).toBe("failed");
        expect(failed.kev.lastError).toBe("HTTP 503");
    });

    it("does not believe a run stamp a dead process left behind hours ago", () => {
        const status = buildMirrorStatus(
            { osv: null, epss: epss({ runStartedAt: new Date("2026-10-17T02:00:00Z") }), kev: null },
            NOW,
        );
        expect(status.epss.status).toBe("pending");
    });

    it("is ready once every feed has completed at least once, whatever their latest run did", () => {
        const rows = {
            osv: osv({ initialized: true, initCompletedAt: NOW, syncStatus: "incremental", ecosystems: ["Alpine"] }),
            epss: epss({
                lastSyncedAt: NOW,
                lastScoreDate: "2026-10-16",
                rowsMatched: 41000,
                lastError: "later run failed",
            }),
            kev: kev({ lastSyncedAt: NOW, catalogVersion: "2026.10.16", entriesMatched: 1300 }),
        };
        const status = buildMirrorStatus(rows, NOW);
        expect(status.ready).toBe(true);
        expect(status.osv).toMatchObject({ status: "ready", initialized: true, ecosystems: ["Alpine"] });
        expect(status.epss).toMatchObject({ status: "ready", scoreDate: "2026-10-16", cvesMatched: 41000 });
        expect(status.kev).toMatchObject({ status: "ready", catalogVersion: "2026.10.16", entriesMatched: 1300 });
    });

    it("is not ready while one feed is still outstanding", () => {
        const status = buildMirrorStatus(
            { osv: osv({ initialized: true }), epss: epss({ lastSyncedAt: NOW }), kev: kev({ runStartedAt: NOW }) },
            NOW,
        );
        expect(status.ready).toBe(false);
        expect(status.kev.status).toBe("running");
    });
});
