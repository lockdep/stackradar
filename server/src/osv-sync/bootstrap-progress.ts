/**
 * The bootstrap's progress, written to `osv_sync_state.bootstrap_progress`
 * for the app shell's banner (`GET /api/vulnerabilities/mirror`).
 *
 * A fresh self-hosted install spends its first five to twenty-five minutes
 * here, serving a dashboard that shows no findings. Until this existed, the
 * only way to know whether the bootstrap was moving was the server log —
 * which a person who just ran `docker compose up` is not reading. The log
 * lines stay; this is the same information, one row read away.
 *
 * Writes are throttled, because the sources fire often: the zip processor
 * reports every thousand records and every five seconds of download. A
 * phase change (new archive, download finished) is written at once, since
 * that is what the banner's wording keys on; everything else waits for the
 * interval. Writes never overlap, and a write that fails is logged and
 * dropped — the bootstrap must not fail because its progress bar did.
 */

import type { BootstrapArchive, BootstrapProgress } from "../db/schema/osv-mirror.js";
import type { SyncStateManager } from "./state.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:bootstrap-progress");

/** Default interval between two throttled writes. */
export const PROGRESS_WRITE_INTERVAL_MS = 2_000;

export interface BootstrapProgressReporter {
    /** Archive `index` (1-based, into the scope the reporter was built with) is starting: phase `downloading`, written at once. */
    startArchive(index: number): void;
    /** Download position for the current archive (throttled). */
    downloaded(bytesReceived: number, contentLength: number | undefined): void;
    /** Records imported from the current archive, of its entry count (throttled; the first call also flips the phase). */
    imported(recordsProcessed: number, archiveEntries: number | undefined): void;
    /** The current archive is finished: its count is recorded against it and joins the running total the next archive reports. */
    finishArchive(recordsProcessed: number): void;
    /** Every archive is in; the generation is being promoted and severities filled. Written at once. */
    publishing(): void;
    /** Wait for the write in flight, so a caller can clear the column without being overtaken by a late snapshot. */
    settle(): Promise<void>;
}

/**
 * `scope` is the run's `config.ecosystems`: one archive per name, or the
 * global `all.zip` when null. It is the plan every snapshot carries, so the
 * banner knows the ecosystems still ahead as well as the ones already in.
 */
export function createBootstrapProgressReporter(
    stateManager: Pick<SyncStateManager, "updateState">,
    scope: readonly string[] | null,
    options: { now?: () => Date; intervalMs?: number } = {},
): BootstrapProgressReporter {
    const now = options.now ?? (() => new Date());
    const intervalMs = options.intervalMs ?? PROGRESS_WRITE_INTERVAL_MS;
    const startedAt = now().toISOString();
    const archives: BootstrapArchive[] = (scope ?? [null]).map((ecosystem) => ({ ecosystem, records: null }));

    let snapshot: BootstrapProgress | null = null;
    let completedRecords = 0;
    let lastWriteAt = 0;
    let inFlight: Promise<void> | null = null;
    let dirty = false;

    const write = (): void => {
        if (!snapshot || inFlight) {
            // A write already running will not carry this update; remember
            // to send another when it lands rather than losing the latest.
            dirty = Boolean(snapshot);
            return;
        }
        dirty = false;
        lastWriteAt = Date.now();
        const value = { ...snapshot, updatedAt: now().toISOString() };
        inFlight = stateManager
            .updateState({ bootstrapProgress: value })
            .catch((error: unknown) => {
                log.warn({ error }, "Failed to record bootstrap progress — continuing");
            })
            .then(() => {
                inFlight = null;
                if (dirty) write();
            });
    };

    const writeThrottled = (): void => {
        if (Date.now() - lastWriteAt >= intervalMs) write();
        else dirty = true;
    };

    return {
        startArchive(index) {
            snapshot = {
                startedAt,
                updatedAt: startedAt,
                archiveIndex: index,
                archiveCount: archives.length,
                ecosystem: archives[index - 1]?.ecosystem ?? null,
                phase: "downloading",
                bytesReceived: 0,
                contentLength: null,
                recordsProcessed: 0,
                archiveEntries: null,
                recordsFromEarlierArchives: completedRecords,
                archives: archives.map((a) => ({ ...a })),
            };
            write();
        },

        downloaded(bytesReceived, contentLength) {
            if (!snapshot) return;
            snapshot = { ...snapshot, bytesReceived, contentLength: contentLength ?? null };
            writeThrottled();
        },

        imported(recordsProcessed, archiveEntries) {
            if (!snapshot) return;
            const phaseChanged = snapshot.phase !== "importing";
            snapshot = {
                ...snapshot,
                phase: "importing",
                recordsProcessed,
                archiveEntries: archiveEntries ?? snapshot.archiveEntries,
            };
            if (phaseChanged) write();
            else writeThrottled();
        },

        finishArchive(recordsProcessed) {
            completedRecords += recordsProcessed;
            if (!snapshot) return;
            const finished = archives[snapshot.archiveIndex - 1];
            if (finished) finished.records = recordsProcessed;
            snapshot = {
                ...snapshot,
                phase: "importing",
                recordsProcessed,
                archives: archives.map((a) => ({ ...a })),
            };
            write();
        },

        publishing() {
            if (!snapshot) return;
            snapshot = { ...snapshot, phase: "publishing" };
            write();
        },

        async settle() {
            // Two rounds: the one in flight, then the one it may have queued.
            while (inFlight) await inFlight;
        },
    };
}
