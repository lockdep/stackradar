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

    function harness(intervalMs = 2_000) {
        const writes: BootstrapProgress[] = [];
        const updateState = vi.fn(async (update: { bootstrapProgress?: BootstrapProgress | null }) => {
            writes.push(update.bootstrapProgress!);
        });
        const reporter = createBootstrapProgressReporter({ updateState }, { intervalMs });
        return { reporter, writes, updateState };
    }

    it("writes a phase change at once and throttles the ticks between", async () => {
        const { reporter, writes } = harness();

        reporter.startArchive({ index: 1, count: 3, ecosystem: "Alpine" });
        await reporter.settle();
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({
            archiveIndex: 1,
            archiveCount: 3,
            ecosystem: "Alpine",
            phase: "downloading",
            bytesReceived: 0,
            recordsFromEarlierArchives: 0,
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

    it("carries finished archives into the next archive's running total", async () => {
        const { reporter, writes } = harness();

        reporter.startArchive({ index: 1, count: 2, ecosystem: "Alpine" });
        reporter.imported(1000, 1200);
        reporter.finishArchive(1150);
        reporter.startArchive({ index: 2, count: 2, ecosystem: "Debian" });
        await reporter.settle();

        const last = writes[writes.length - 1]!;
        expect(last).toMatchObject({
            archiveIndex: 2,
            ecosystem: "Debian",
            phase: "downloading",
            recordsProcessed: 0,
            recordsFromEarlierArchives: 1150,
        });
        expect(last.startedAt).toBe("2026-10-17T10:00:00.000Z");
    });

    it("never overlaps writes, and sends the latest state once the write in flight lands", async () => {
        const { reporter, writes, updateState } = harness(0);
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

        reporter.startArchive({ index: 1, count: 1, ecosystem: null });
        reporter.imported(1000, undefined);
        reporter.imported(2000, undefined);
        expect(updateState).toHaveBeenCalledTimes(1);

        release();
        await reporter.settle();
        expect(updateState).toHaveBeenCalledTimes(2);
        expect(writes[1]).toMatchObject({ phase: "importing", recordsProcessed: 2000 });
    });

    it("drops a failed write and keeps reporting", async () => {
        const { reporter, writes, updateState } = harness(0);
        updateState.mockRejectedValueOnce(new Error("connection reset"));

        reporter.startArchive({ index: 1, count: 1, ecosystem: null });
        await reporter.settle();
        reporter.publishing();
        await reporter.settle();

        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatchObject({ phase: "publishing" });
    });
});
