import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBootstrapProgressReporter } from "../../../src/osv-sync/bootstrap-progress.js";
import type { BootstrapProgress } from "../../../src/db/schema/osv-mirror.js";

/**
 * The reporter's job is to turn a stream of callbacks into a few row writes:
 * one per phase change, at most one per interval otherwise, never two at
 * once, and never one that outlives `settle()`.
 */
describe("createBootstrapProgressReporter", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    function harness(scope: readonly string[] | null, intervalMs = 2_000) {
        const writes: BootstrapProgress[] = [];
        const updateState = vi.fn(async (update: { bootstrapProgress?: BootstrapProgress | null }) => {
            writes.push(update.bootstrapProgress!);
        });
        const reporter = createBootstrapProgressReporter({ updateState }, scope, { intervalMs });
        return { reporter, writes, updateState };
    }

    it("writes a phase change at once and throttles the ticks between", async () => {
        const { reporter, writes } = harness(["Alpine", "Debian", "npm"]);

        reporter.startArchive(1);
        await reporter.settle();
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
            archiveIndex: 1,
            archiveCount: 3,
            ecosystem: "Alpine",
            phase: "downloading",
            bytesReceived: 0,
            recordsFromEarlierArchives: 0,
            archives: [
                { ecosystem: "Alpine", records: null },
                { ecosystem: "Debian", records: null },
                { ecosystem: "npm", records: null },
            ],
        });

        // Download ticks inside the interval are held back …
        reporter.downloaded(100, 1000);
        reporter.downloaded(200, 1000);
        await reporter.settle();
        expect(writes).toHaveLength(1);

        // … and the next one after it carries the latest position.
        vi.advanceTimersByTime(2_000);
        reporter.downloaded(300, 1000);
        await reporter.settle();
        expect(writes).toHaveLength(2);
        expect(writes[1]).toMatchObject({ phase: "downloading", bytesReceived: 300, contentLength: 1000 });

        // The first import tick is a phase change: written regardless of the interval.
        reporter.imported(1000, 50_000);
        await reporter.settle();
        expect(writes).toHaveLength(3);
        expect(writes[2]).toMatchObject({ phase: "importing", recordsProcessed: 1000, archiveEntries: 50_000 });
    });

    it("carries finished archives into the next archive's running total, and ticks them off by name", async () => {
        const { reporter, writes } = harness(["Alpine", "Debian"]);

        reporter.startArchive(1);
        reporter.imported(1000, 1200);
        reporter.finishArchive(1150);
        reporter.startArchive(2);
        await reporter.settle();

        const last = writes[writes.length - 1]!;
        expect(last).toMatchObject({
            archiveIndex: 2,
            archiveCount: 2,
            ecosystem: "Debian",
            phase: "downloading",
            recordsProcessed: 0,
            recordsFromEarlierArchives: 1150,
            archives: [
                { ecosystem: "Alpine", records: 1150 },
                { ecosystem: "Debian", records: null },
            ],
        });
        expect(last.startedAt).toBe("2026-10-17T10:00:00.000Z");

        // A snapshot is a value: a later finish does not rewrite the one already written.
        reporter.finishArchive(900);
        await reporter.settle();
        expect(last.archives[1]).toEqual({ ecosystem: "Debian", records: null });
        expect(writes[writes.length - 1]!.archives[1]).toEqual({ ecosystem: "Debian", records: 900 });
    });

    it("plans one unnamed archive for the global all.zip", async () => {
        const { reporter, writes } = harness(null);

        reporter.startArchive(1);
        await reporter.settle();
        expect(writes[0]).toMatchObject({
            archiveIndex: 1,
            archiveCount: 1,
            ecosystem: null,
            archives: [{ ecosystem: null, records: null }],
        });
    });

    it("never overlaps writes, and sends the latest state once the write in flight lands", async () => {
        const { reporter, writes, updateState } = harness(null, 0);
        let release!: () => void;
        updateState.mockImplementationOnce(
            (update) =>
                new Promise<void>((resolve) => {
                    release = () => {
                        writes.push(update.bootstrapProgress!);
                        resolve();
                    };
                }),
        );

        reporter.startArchive(1);
        reporter.imported(1000, undefined);
        reporter.imported(2000, undefined);
        expect(updateState).toHaveBeenCalledTimes(1);

        release();
        await reporter.settle();
        expect(updateState).toHaveBeenCalledTimes(2);
        expect(writes[1]).toMatchObject({ phase: "importing", recordsProcessed: 2000 });
    });

    it("drops a failed write and keeps reporting", async () => {
        const { reporter, writes, updateState } = harness(null, 0);
        updateState.mockRejectedValueOnce(new Error("connection reset"));

        reporter.startArchive(1);
        await reporter.settle();
        reporter.publishing();
        await reporter.settle();

        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ phase: "publishing" });
    });
});
