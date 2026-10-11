import { describe, it, expect, vi } from "vitest";
import { loadSchedules, runStartupSyncs, type SyncRunners } from "../../src/sync-scheduler.js";
import type { SyncCycleResult } from "../../src/osv-sync/types.js";

function cycle(overrides: Partial<SyncCycleResult>): SyncCycleResult {
    return {
        success: true,
        mode: "initialization",
        syncRunId: "run",
        recordsProcessed: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        affectedPackagesExtracted: 0,
        schemaValidationWarnings: 0,
        parseFailures: 0,
        deduplicatedCandidates: 0,
        deduplications: [],
        errors: [],
        durationMs: 1,
        lagSeconds: undefined,
        ...overrides,
    };
}

function runners(
    bootstrap: SyncCycleResult | Error,
): SyncRunners & { epss: ReturnType<typeof vi.fn>; kev: ReturnType<typeof vi.fn> } {
    return {
        osv: {
            runCycle: vi.fn(),
            bootstrapIfNeeded: vi.fn(
                bootstrap instanceof Error ? () => Promise.reject(bootstrap) : () => Promise.resolve(bootstrap),
            ),
        },
        epss: vi.fn().mockResolvedValue({ skipped: true, reason: "fresh" }),
        kev: vi.fn().mockResolvedValue({ skipped: true, reason: "fresh" }),
    };
}

/**
 * The monolith's start-up pass (`src/sync-scheduler.ts`): the bootstrap
 * check first, then EPSS and KEV — forced only when a bootstrap actually
 * ran, because the daily run's freshness guard would otherwise leave a
 * just-built mirror unscored for a day.
 */
describe("runStartupSyncs", () => {
    it("forces EPSS and KEV after a bootstrap ran", async () => {
        const r = runners(cycle({ recordsProcessed: 1000 }));
        const outcome = await runStartupSyncs(r);
        expect(outcome.bootstrapped).toBe(true);
        expect(r.epss).toHaveBeenCalledWith(true);
        expect(r.kev).toHaveBeenCalledWith(true);
    });

    it("leaves the freshness guards on when the mirror was already complete", async () => {
        const r = runners(cycle({ noop: true }));
        const outcome = await runStartupSyncs(r);
        expect(outcome.bootstrapped).toBe(false);
        expect(r.epss).toHaveBeenCalledWith(false);
        expect(r.kev).toHaveBeenCalledWith(false);
    });

    it("does not count a lock-held skip or a failed rebuild as a bootstrap", async () => {
        for (const result of [cycle({ skipped: true, success: false }), cycle({ success: false, errors: ["boom"] })]) {
            const r = runners(result);
            expect((await runStartupSyncs(r)).bootstrapped).toBe(false);
            expect(r.epss).toHaveBeenCalledWith(false);
        }
    });

    it("still runs the feeds when the bootstrap throws — a feed outage is never a reason to stop serving", async () => {
        const r = runners(new Error("bucket unreachable"));
        await expect(runStartupSyncs(r)).resolves.toEqual({ bootstrapped: false });
        expect(r.epss).toHaveBeenCalledTimes(1);
        expect(r.kev).toHaveBeenCalledTimes(1);
    });

    it("runs the Artifact Hub sync only when wired, and never forced", async () => {
        const r = runners(cycle({ recordsProcessed: 1 }));
        const artifactHub = vi.fn().mockResolvedValue({ skipped: false });
        await runStartupSyncs({ ...r, artifactHub });
        expect(artifactHub).toHaveBeenCalledWith(false);
    });
});

describe("loadSchedules", () => {
    it("defaults to the cloud CronJobs' schedules, off the hour for the feeds", () => {
        expect(loadSchedules({})).toEqual({
            osvSync: "0 * * * *",
            osvBootstrap: "0 */12 * * *",
            epss: "15 6 * * *",
            kev: "15 7 * * *",
            artifactHub: "15 2 * * *",
        });
    });

    it("reads overrides and treats an empty value as unset", () => {
        const s = loadSchedules({ OSV_SYNC_CRON: "*/30 * * * *", EPSS_SYNC_CRON: "" });
        expect(s.osvSync).toBe("*/30 * * * *");
        expect(s.epss).toBe("15 6 * * *");
    });
});
