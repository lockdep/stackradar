import { randomUUID } from "node:crypto";
import type { OsvSyncConfig } from "./config.js";
import type { SyncStateManager } from "./state.js";
import type { OsvDownloader } from "./downloader.js";
import type { ZipProcessor } from "./zip-processor.js";
import type { OsvAffectedPackageRepository } from "./affected-package-repository.js";
import { vulnerabilityMirrorRepository } from "../repositories/index.js";
import type { OsvSyncFailureRepository } from "./failure-repository.js";
import type { OsvSyncRunRepository } from "./run-repository.js";
import type { SyncCycleResult, SyncPhaseDeps } from "./types.js";
export type { SyncCycleResult } from "./types.js";
import { runBootstrap } from "./bootstrap.js";
import { runIncremental } from "./incremental.js";
import { enqueueRescansAfterMirrorChange } from "./rescan.js";
import { SyncCounters } from "./sync-utils.js";
import { missingFromScope } from "./ecosystems.js";
import { createLogger } from "../lib/logger.js";
import type { OsvSyncState } from "../db/schema/osv-mirror.js";

const log = createLogger("osv-sync:worker");

export interface OsvSyncWorker {
    /**
     * Run a single sync cycle (initialization or incremental)
     */
    runCycle(): Promise<SyncCycleResult>;

    /**
     * Force a full refresh (re-initialize from all.zip)
     */
    forceFullRefresh(): Promise<SyncCycleResult>;

    /**
     * Bootstrap only if the mirror has never completed a generation — or was
     * built with a narrower `OSV_ECOSYSTEMS` than the process now wants —
     * and otherwise return immediately having done nothing.
     *
     * This is the scheduled counterpart to `forceFullRefresh()`, and the reason
     * a nuked database no longer needs an operator. It is deliberately NOT part
     * of `runCycle()`: the hourly job's deadline is sized for an incremental
     * run, and a rebuild started there would be killed and restarted from zero
     * on every tick forever. Give this its own CronJob with its own deadline.
     */
    bootstrapIfNeeded(): Promise<SyncCycleResult>;

    /**
     * Get current sync metrics
     */
    getMetrics(): Promise<{
        initialized: boolean;
        lagSeconds: number | null;
        consecutiveFailures: number;
        lastError: string | null;
        totalRecords: number;
    }>;

    /**
     * Release the advisory lock and clean up resources.
     * Should be called when the worker is no longer needed.
     */
    shutdown(): Promise<void>;
}

export function createOsvSyncWorker(
    config: OsvSyncConfig,
    stateManager: SyncStateManager,
    downloader: OsvDownloader,
    zipProcessor: ZipProcessor,
    affectedPkgRepository: OsvAffectedPackageRepository,
    failureRepository: OsvSyncFailureRepository,
    runRepository: OsvSyncRunRepository,
): OsvSyncWorker {
    let lockAcquired = false;
    // The entry point running in this process right now, if any. The monolith
    // shares one worker between the start-up bootstrap and the hourly cron, and
    // `lockAcquired` alone cannot tell "we hold the lock" from "the other entry
    // point holds it": at the first top of the hour inside a bootstrap, the
    // incremental run believed it held the lock, "recovered" the bootstrap's
    // `full_refresh` status to idle — taking the banner's progress with it —
    // and its release dropped the lock out from under the import still running.
    let running: "initialization" | "incremental" | null = null;

    const deps: SyncPhaseDeps = {
        config,
        stateManager,
        downloader,
        zipProcessor,
        affectedPkgRepository,
        failureRepository,
        runRepository,
    };

    async function tryAcquireLock(): Promise<boolean> {
        if (lockAcquired) return true;
        lockAcquired = await stateManager.tryAcquireAdvisoryLock(config.advisoryLockId);
        if (lockAcquired) log.info("Advisory lock acquired");
        return lockAcquired;
    }

    function failedResult(mode: "initialization" | "incremental", error: string): SyncCycleResult {
        // Fresh counters: a run that never started has all-zero tallies.
        return new SyncCounters().toResult({
            success: false,
            mode,
            syncRunId: randomUUID(),
            errors: [error],
            durationMs: 0,
            lagSeconds: undefined,
        });
    }

    function lockHeldResult(
        mode: "initialization" | "incremental",
        reason = "Advisory lock held by another instance",
    ): SyncCycleResult {
        // Not a failure: `concurrencyPolicy: Forbid` makes this rare, but a
        // manual run overlapping the CronJob is a normal thing to do and must
        // not spend the Job's retries or fire an alert.
        return {
            ...failedResult(mode, reason),
            skipped: true,
        };
    }

    /**
     * One run per process at a time. A second entry point while one is in
     * progress is answered exactly like a lock held by another instance —
     * skipped, not failed — before it reads or writes the state row.
     */
    async function oneAtATime(
        mode: "initialization" | "incremental",
        run: () => Promise<SyncCycleResult>,
    ): Promise<SyncCycleResult> {
        if (running) {
            log.info({ running, requested: mode }, "A sync is already running in this process. Exiting.");
            return lockHeldResult(mode, `A ${running} sync is already running in this process`);
        }
        running = mode;
        try {
            return await run();
        } finally {
            running = null;
        }
    }

    /**
     * Nothing to do: the mirror already has a complete generation. Success
     * rather than failure, and `noop` rather than `skipped` — see the field
     * docs on SyncCycleResult.
     */
    function alreadyInitializedResult(): SyncCycleResult {
        return {
            ...failedResult("initialization", ""),
            success: true,
            noop: true,
            errors: [],
        };
    }

    /**
     * Drop failure rows past the retention window. `osv_sync_failures` gains a
     * row per schema-validation warning on every run, and nothing but a manual
     * admin endpoint ever removed one.
     *
     * Housekeeping, so its own failure is logged and swallowed: a sync that
     * applied its records correctly did its job whether or not the sweep ran.
     */
    async function sweepOldFailures(): Promise<void> {
        if (config.failureRetentionDays <= 0) return;

        const cutoff = new Date(Date.now() - config.failureRetentionDays * 24 * 60 * 60 * 1000);
        try {
            const deleted = await failureRepository.deleteOlderThan(cutoff);
            if (deleted > 0) {
                log.info(
                    { deleted, olderThan: cutoff.toISOString(), retentionDays: config.failureRetentionDays },
                    "Swept expired sync failures",
                );
            }
        } catch (error) {
            log.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to sweep expired sync failures",
            );
        }
    }

    /**
     * Why `bootstrapIfNeeded` would rebuild, or null when it would not.
     *
     * Two reasons, not one. No complete generation is the classic case. The
     * second is a scope gap: the live generation was built from a list of
     * ecosystems (`osv_sync_state.ecosystems`) that does not cover what
     * `OSV_ECOSYSTEMS` now asks for. The incremental sync cannot close that
     * gap — it only ever applies records newer than the watermark — so
     * widening the variable after the bootstrap would otherwise do nothing,
     * forever, while reporting a healthy mirror.
     */
    function rebuildReason(state: OsvSyncState): string | null {
        if (!state.initialized) return "no complete generation";
        const missing = missingFromScope(state.ecosystems ?? null, config.ecosystems);
        if (missing.length === 0) return null;
        return missing[0] === "*"
            ? "mirror is scoped to a list of ecosystems but OSV_ECOSYSTEMS now asks for everything"
            : `mirror does not carry ${missing.join(", ")} (OSV_ECOSYSTEMS widened since the last bootstrap)`;
    }

    // Recover from stale syncStatus left by a previously crashed run.
    // Since we hold the advisory lock, no other sync is active — any
    // non-idle status must be a leftover that would otherwise block
    // vulnerability matching indefinitely.
    async function resetStaleSyncStatus(): Promise<void> {
        const state = await stateManager.getState();
        if (state.syncStatus !== "idle") {
            log.warn(
                { syncStatus: state.syncStatus },
                "Stale sync status detected (previous run crashed). Resetting to idle.",
            );
            await stateManager.setSyncStatus("idle");
        }
    }

    async function runCycle(): Promise<SyncCycleResult> {
        return oneAtATime("incremental", async () => {
            await stateManager.ensureInitialized();

            if (!(await tryAcquireLock())) {
                log.info("Another instance is running (advisory lock held). Exiting.");
                return lockHeldResult("incremental");
            }

            await resetStaleSyncStatus();

            const state = await stateManager.getState();

            // The scheduled path never bootstraps. This entry point is what the
            // hourly CronJob calls, and a full rebuild is a 1.35 GB download that
            // takes hours and cannot resume — put it on an hourly trigger and a
            // cleared `initialized` flag (a restored database, a manual reset)
            // silently becomes a rebuild every hour, each one starting from zero.
            // A rebuild belongs on a schedule slow enough and a deadline long
            // enough to finish one: `--bootstrap-if-needed`, or `--full-refresh`
            // to force one by hand.
            if (!state.initialized) {
                const message =
                    "OSV mirror is not initialized — run the bootstrap job " +
                    "(`pnpm osv-sync --full-refresh`). The scheduled sync will not start a full rebuild.";
                log.error(message);
                return failedResult("incremental", message);
            }

            // Not a failure — the sync still keeps the ecosystems it has
            // current — but it must be said every hour until it is fixed,
            // because nothing else in the system can tell.
            const scopeGap = rebuildReason(state);
            if (scopeGap) {
                log.warn(
                    { mirrored: state.ecosystems ?? "all", configured: config.ecosystems ?? "all" },
                    `OSV ${scopeGap}; the incremental sync cannot add ecosystems — ` +
                        "`--bootstrap-if-needed` (the monolith does this at start-up and twice a day) or `--full-refresh` rebuilds",
                );
            }

            const result = await runIncremental(deps);
            if (result.success) {
                await sweepOldFailures();
                // A mirror that answers differently than an hour ago makes
                // every existing verdict stale; this is what refreshes them.
                // No-op when the cycle applied nothing.
                await enqueueRescansAfterMirrorChange(result);
            }
            return result;
        });
    }

    async function forceFullRefresh(): Promise<SyncCycleResult> {
        return oneAtATime("initialization", async () => {
            await stateManager.ensureInitialized();

            if (!(await tryAcquireLock())) {
                log.info("Another instance is running (advisory lock held). Cannot refresh.");
                return lockHeldResult("initialization");
            }

            log.info("Starting forced full refresh");
            await resetStaleSyncStatus();
            // `initialized` is deliberately left alone. It now means "a complete
            // generation of the mirror exists", which stays true throughout a
            // rebuild — the old generation serves reads until the swap. Clearing
            // it here would take matching down for the duration of a refresh that
            // exists precisely so it does not have to.
            const result = await runBootstrap(deps);
            if (result.success) {
                await sweepOldFailures();
                // A mirror that answers differently than an hour ago makes
                // every existing verdict stale; this is what refreshes them.
                // No-op when the cycle applied nothing.
                await enqueueRescansAfterMirrorChange(result);
            }
            return result;
        });
    }

    async function bootstrapIfNeeded(): Promise<SyncCycleResult> {
        return oneAtATime("initialization", async () => {
            await stateManager.ensureInitialized();

            // Cheap pre-check before touching the lock. This runs on a schedule
            // and the overwhelmingly common answer is "nothing to do", which
            // should cost one SELECT rather than a lock round-trip.
            if (rebuildReason(await stateManager.getState()) === null) {
                log.info("Mirror already has a complete generation covering OSV_ECOSYSTEMS — nothing to do");
                return alreadyInitializedResult();
            }

            if (!(await tryAcquireLock())) {
                log.info("Another instance is running (advisory lock held). Exiting.");
                return lockHeldResult("initialization");
            }

            // Re-read under the lock: the pre-check is not authoritative. A
            // manual --full-refresh could have finished in the gap, and starting
            // a second multi-hour rebuild on top of a completed one is pure
            // waste.
            const reason = rebuildReason(await stateManager.getState());
            if (reason === null) {
                log.info("Mirror was initialized while acquiring the lock — nothing to do");
                return alreadyInitializedResult();
            }

            log.warn(
                { ecosystems: config.ecosystems ?? "all" },
                `OSV mirror: ${reason} — starting unattended bootstrap`,
            );
            await resetStaleSyncStatus();
            const result = await runBootstrap(deps);
            if (result.success) {
                await sweepOldFailures();
                // A mirror that answers differently than an hour ago makes
                // every existing verdict stale; this is what refreshes them.
                // No-op when the cycle applied nothing.
                await enqueueRescansAfterMirrorChange(result);
            }
            return result;
        });
    }

    return {
        runCycle,
        forceFullRefresh,
        bootstrapIfNeeded,

        async getMetrics(): Promise<{
            initialized: boolean;
            lagSeconds: number | null;
            consecutiveFailures: number;
            lastError: string | null;
            totalRecords: number;
        }> {
            const state = await stateManager.getState();
            const lagSeconds = await stateManager.getLagSeconds();
            // Planner estimate, not `count(*)` — this is a status surface and
            // an exact count is a full scan of the mirror.
            const totalRecords = await vulnerabilityMirrorRepository.getVulnerabilityCountEstimate();

            return {
                initialized: state.initialized,
                lagSeconds,
                consecutiveFailures: state.consecutiveFailures,
                lastError: state.lastError,
                totalRecords,
            };
        },

        async shutdown(): Promise<void> {
            // The lock belongs to the run in progress; a caller releasing after
            // a skipped call must not take it from under the one that holds it.
            if (running) {
                log.info({ running }, "Advisory lock kept: a sync is still running in this process");
                return;
            }
            if (lockAcquired) {
                try {
                    await stateManager.releaseAdvisoryLock(config.advisoryLockId);
                    lockAcquired = false;
                    log.info("Advisory lock released");
                } catch (error) {
                    log.warn(
                        { error: error instanceof Error ? error.message : String(error) },
                        "Failed to release advisory lock",
                    );
                }
            }
        },
    };
}
