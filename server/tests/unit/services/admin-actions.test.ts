/**
 * The admin actions' two rules that need no database: a feed trigger runs
 * the scheduler's own runner exactly once at a time per process, and the
 * split topology refuses with the CronJob's name instead of pretending.
 * The runners are fakes that resolve when told to, so "already running" is
 * a state the test holds, not a race it hopes to hit.
 */

import { describe, it, expect, vi } from "vitest";
import {
    triggerSync,
    actionInFlight,
    AdminActionInProgressError,
    AdminActionUnavailableError,
    type AdminActionDeps,
} from "../../../src/services/admin-actions.service.js";
import type { SyncRunners } from "../../../src/sync-scheduler.js";

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function fakeRunners(overrides: Partial<SyncRunners> = {}): SyncRunners {
    const done = { success: true, mode: "incremental" as const } as unknown as Awaited<
        ReturnType<SyncRunners["osv"]["runCycle"]>
    >;
    return {
        osv: { runCycle: vi.fn(async () => done), bootstrapIfNeeded: vi.fn(async () => done) },
        epss: vi.fn(async () => ({ skipped: false })),
        kev: vi.fn(async () => ({ skipped: false })),
        ...overrides,
    };
}

const monolith = (runners: SyncRunners): AdminActionDeps => ({ topology: "monolith", runners });

describe("triggerSync", () => {
    it("runs the scheduler's runner and answers before it finishes", async () => {
        const run = deferred<unknown>();
        const runners = fakeRunners({ epss: vi.fn(() => run.promise as Promise<{ skipped: boolean }>) });

        const started = triggerSync("epss", "admin-1", monolith(runners));

        expect(started.action).toBe("epss");
        // Forced: a person asked, so the daily freshness guard is bypassed.
        expect(runners.epss).toHaveBeenCalledWith(true);
        expect(actionInFlight("epss")).not.toBeNull();

        run.resolve({ skipped: false });
        await run.promise;
        await new Promise((r) => setImmediate(r));
        expect(actionInFlight("epss")).toBeNull();
    });

    it("refuses a second click while the first run is in progress, and allows one after", async () => {
        const run = deferred<unknown>();
        const runners = fakeRunners({ kev: vi.fn(() => run.promise as Promise<{ skipped: boolean }>) });

        triggerSync("kev", "admin-1", monolith(runners));
        expect(() => triggerSync("kev", "admin-2", monolith(runners))).toThrow(AdminActionInProgressError);
        expect(runners.kev).toHaveBeenCalledTimes(1);

        run.resolve({ skipped: false });
        await run.promise;
        await new Promise((r) => setImmediate(r));

        triggerSync("kev", "admin-2", monolith(runners));
        expect(runners.kev).toHaveBeenCalledTimes(2);
    });

    it("refuses in the split topology, naming the CronJob to run instead", () => {
        const runners = fakeRunners();
        let caught: unknown;
        try {
            triggerSync("osv-sync", "admin-1", { topology: "split", runners });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(AdminActionUnavailableError);
        expect((caught as AdminActionUnavailableError).statusCode).toBe(409);
        expect((caught as Error).message).toContain("osv-sync CronJob");
        expect(runners.osv.runCycle).not.toHaveBeenCalled();
    });

    it("refuses when no runners were registered, which is what the split API process has", () => {
        expect(() => triggerSync("osv-bootstrap", "admin-1", { topology: "monolith", runners: null })).toThrow(
            AdminActionUnavailableError,
        );
    });

    it("refuses the Artifact Hub trigger when that sync is switched off", () => {
        const runners = fakeRunners();
        delete runners.artifactHub;
        let caught: unknown;
        try {
            triggerSync("artifacthub", "admin-1", monolith(runners));
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(AdminActionUnavailableError);
        expect((caught as Error).message).toContain("ARTIFACT_HUB_SYNC_ENABLED=false");
    });
});
