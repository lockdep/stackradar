/**
 * The monolith's in-process scheduler for the vulnerability feeds
 * (`src/topology.ts`).
 *
 * A hosted deployment runs these as external Kubernetes CronJobs; a
 * community install is one server process, so the same work runs here, on
 * the same schedules, through the same code the CLIs call:
 *
 * | Feed                       | Default schedule   | CLI equivalent                   |
 * |----------------------------|--------------------|----------------------------------|
 * | OSV incremental sync       | `0 * * * *`        | `osv-sync --once`                |
 * | OSV bootstrap check        | every 12 h, :00    | `osv-sync --bootstrap-if-needed` |
 * | EPSS scores                | `15 6 * * *`       | `epss-sync --once`               |
 * | CISA KEV catalogue         | `15 7 * * *`       | `kev-sync --once`                |
 * | Artifact Hub mirror        | `15 2 * * *`       | `artifacthub-sync --once`        |
 *
 * Plus a **start-up pass**: the bootstrap check runs as soon as the server
 * listens, so a fresh install has a mirror in minutes rather than at the
 * next 12-hour tick, and EPSS and KEV follow it — forced when a bootstrap
 * just ran, since an empty mirror the daily run already "scored" would
 * otherwise wait a day for its first real scores.
 *
 * Replicas are safe. Each feed coordinates on the database, not in this
 * process: the OSV sync holds a session advisory lock for the duration of
 * a run (released after each one here, so a manual CLI run is never shut
 * out by an idle server), EPSS and KEV take a transaction advisory lock on
 * their apply, and the Artifact Hub sync's freshness guard makes the
 * second run a no-op. Within one process croner's `protect` keeps a slow
 * run from overlapping its own next tick.
 */

import { Cron } from "croner";
import { integrations } from "./config/index.js";
import { createLogger } from "./lib/logger.js";
import { envString, type Env } from "./lib/env.js";
import { createOsvSyncRuntime, type OsvSyncRuntime } from "./osv-sync/runtime.js";
import type { SyncCycleResult } from "./osv-sync/types.js";
import { loadConfig as loadEpssConfig } from "./epss-sync/config.js";
import { createEpssDownloader } from "./epss-sync/downloader.js";
import { createEpssRepository } from "./epss-sync/repository.js";
import { createEpssSyncWorker } from "./epss-sync/worker.js";
import { loadConfig as loadKevConfig } from "./kev-sync/config.js";
import { createKevRepository } from "./kev-sync/repository.js";
import { createKevSyncWorker } from "./kev-sync/worker.js";
import { recordKevListings } from "./services/kev-listing.service.js";
import { loadConfig as loadArtifactHubConfig } from "./artifacthub-sync/config.js";
import { createArtifactHubDownloader } from "./artifacthub-sync/downloader.js";
import { createArtifactHubSyncRepository } from "./artifacthub-sync/repository.js";
import { createArtifactHubSyncWorker } from "./artifacthub-sync/worker.js";

const log = createLogger("sync-scheduler");

type FeedResult = { skipped: boolean; reason?: string };

/** The runs the scheduler drives, abstracted so the start-up logic is testable without a database. */
export interface SyncRunners {
    osv: {
        runCycle(): Promise<SyncCycleResult>;
        bootstrapIfNeeded(): Promise<SyncCycleResult>;
    };
    epss(force: boolean): Promise<FeedResult>;
    kev(force: boolean): Promise<FeedResult>;
    /** Absent when `ARTIFACT_HUB_SYNC_ENABLED=false`. */
    artifactHub?: (force: boolean) => Promise<FeedResult>;
}

export interface SyncSchedules {
    osvSync: string;
    osvBootstrap: string;
    epss: string;
    kev: string;
    artifactHub: string;
}

export function loadSchedules(env: Env = process.env): SyncSchedules {
    const read = (key: string, fallback: string) => envString(key, fallback, env);
    return {
        osvSync: read("OSV_SYNC_CRON", "0 * * * *"),
        osvBootstrap: read("OSV_BOOTSTRAP_CRON", "0 */12 * * *"),
        // Off the hour on purpose, like the CronJobs: EPSS, KEV and the OSV
        // sync all UPDATE `vulnerabilities`, and a shared start minute
        // produced a deadlock on 2026-09-11.
        epss: read("EPSS_SYNC_CRON", "15 6 * * *"),
        kev: read("KEV_SYNC_CRON", "15 7 * * *"),
        artifactHub: read("ARTIFACT_HUB_SYNC_CRON", "15 2 * * *"),
    };
}

export interface StartupSyncOutcome {
    /** A full bootstrap ran to completion in this pass. */
    bootstrapped: boolean;
}

/**
 * The start-up pass. Exported for its test: the ordering and the forcing
 * rule are the logic, the runners are plumbing.
 *
 * Every step is best-effort and logged — a feed that cannot be reached at
 * boot is the scheduled run's problem an hour or a day later, never a
 * reason to stop serving.
 */
export async function runStartupSyncs(runners: SyncRunners): Promise<StartupSyncOutcome> {
    let bootstrapped = false;
    try {
        const result = await runners.osv.bootstrapIfNeeded();
        bootstrapped = result.success && !result.noop && !result.skipped;
        if (bootstrapped) {
            log.info(
                { recordsProcessed: result.recordsProcessed, durationMs: result.durationMs },
                "OSV mirror bootstrapped at start-up",
            );
        } else if (!result.success) {
            log.error(
                { errors: result.errors.slice(0, 5) },
                "OSV bootstrap at start-up failed; the scheduled check will retry",
            );
        }
    } catch (error) {
        log.error({ error }, "OSV bootstrap at start-up threw; the scheduled check will retry");
    }

    // Forced after a bootstrap: the mirror the daily EPSS run last scored
    // may have been empty, and its 23 h freshness guard would otherwise
    // leave every new advisory unscored until tomorrow.
    for (const [name, run] of [
        ["EPSS", runners.epss],
        ["KEV", runners.kev],
    ] as const) {
        try {
            const result = await run(bootstrapped);
            log.info(
                { skipped: result.skipped, reason: result.reason, forced: bootstrapped },
                `${name} start-up sync done`,
            );
        } catch (error) {
            log.error({ error }, `${name} start-up sync failed; the daily run will retry`);
        }
    }

    if (runners.artifactHub) {
        try {
            const result = await runners.artifactHub(false);
            log.info({ skipped: result.skipped, reason: result.reason }, "Artifact Hub start-up sync done");
        } catch (error) {
            log.error({ error }, "Artifact Hub start-up sync failed; the nightly run will retry");
        }
    }

    return { bootstrapped };
}

/** The real runners, over the real database. */
export function createSyncRunners(osv: OsvSyncRuntime): SyncRunners {
    const epssConfig = loadEpssConfig();
    const epssRepository = createEpssRepository();
    const kevConfig = loadKevConfig();
    const kevRepository = createKevRepository();

    // The OSV worker keeps its session lock once acquired, which is right
    // for a CLI that exits and wrong for a process that lives for weeks:
    // an idle server would shut out every `pnpm osv-sync` a person ran by
    // hand, and a second replica for good. `shutdown()` is only the lock
    // release — and a no-op while a run is in progress, so releasing after a
    // call the worker skipped (the hourly tick during the start-up bootstrap)
    // leaves the running one its lock; the next run re-acquires.
    const releaseAfter = async <T>(run: () => Promise<T>): Promise<T> => {
        try {
            return await run();
        } finally {
            await osv.worker.shutdown();
        }
    };

    const runners: SyncRunners = {
        osv: {
            runCycle: () => releaseAfter(() => osv.worker.runCycle()),
            bootstrapIfNeeded: () => releaseAfter(() => osv.worker.bootstrapIfNeeded()),
        },
        epss: (force) =>
            createEpssSyncWorker(epssConfig, createEpssDownloader(epssConfig), epssRepository).runOnce({ force }),
        kev: (force) =>
            createKevSyncWorker(kevConfig, kevRepository, {
                onNewlyListed: (listed, previous) => recordKevListings(listed, previous),
            }).runOnce({ force }),
    };

    if (integrations.artifactHubSync) {
        const ahConfig = loadArtifactHubConfig();
        const ahRepository = createArtifactHubSyncRepository();
        runners.artifactHub = (force) =>
            createArtifactHubSyncWorker(ahConfig, createArtifactHubDownloader(ahConfig), ahRepository).runOnce({
                force,
            });
    }

    return runners;
}

export interface SyncSchedulerHandle {
    /** The runs the crons drive — the admin page's triggers call the same ones, behind the same locks. */
    runners: SyncRunners;
    /** Resolves when the start-up pass has finished (it never rejects). */
    startup: Promise<StartupSyncOutcome>;
    /** Stop the crons and close the sync's own connections. A run in progress finishes. */
    stop(): Promise<void>;
}

export function startSyncScheduler(
    options: { schedules?: SyncSchedules; runners?: SyncRunners } = {},
): SyncSchedulerHandle {
    const schedules = options.schedules ?? loadSchedules();
    // Its own small pool beside the API's (`db/index.ts`): the sync's
    // statements have no timeout and the advisory lock is session-level.
    const osv = options.runners ? null : createOsvSyncRuntime({ poolMax: 4 });
    const runners = options.runners ?? createSyncRunners(osv!);

    // UTC, whatever the pod's TZ: the schedules above are documented in UTC
    // and are the cloud CronJobs' (which Kubernetes runs in UTC), and the
    // EPSS/KEV offsets exist to land after FIRST.org's ~00:00 UTC publish.
    const cronOptions = { catch: true, protect: true, timezone: "UTC" } as const;

    const jobs: Cron[] = [
        new Cron(schedules.osvSync, { ...cronOptions, name: "osv-sync" }, async () => {
            const result = await runners.osv.runCycle();
            const level = result.success || result.skipped ? "info" : "error";
            log[level](
                {
                    success: result.success,
                    skipped: result.skipped,
                    recordsProcessed: result.recordsProcessed,
                    inserted: result.inserted,
                    updated: result.updated,
                    lagSeconds: result.lagSeconds,
                    durationMs: result.durationMs,
                    ...(result.errors.length > 0 && { errors: result.errors.slice(0, 5) }),
                },
                "OSV incremental sync finished",
            );
        }),
        new Cron(schedules.osvBootstrap, { ...cronOptions, name: "osv-bootstrap" }, async () => {
            const result = await runners.osv.bootstrapIfNeeded();
            if (result.noop) return;
            const level = result.success || result.skipped ? "info" : "error";
            log[level](
                {
                    success: result.success,
                    skipped: result.skipped,
                    recordsProcessed: result.recordsProcessed,
                    durationMs: result.durationMs,
                },
                "OSV bootstrap check finished",
            );
        }),
        new Cron(schedules.epss, { ...cronOptions, name: "epss-sync" }, async () => {
            const result = await runners.epss(false);
            log.info({ skipped: result.skipped, reason: result.reason }, "EPSS sync finished");
        }),
        new Cron(schedules.kev, { ...cronOptions, name: "kev-sync" }, async () => {
            const result = await runners.kev(false);
            log.info({ skipped: result.skipped, reason: result.reason }, "KEV sync finished");
        }),
    ];
    if (runners.artifactHub) {
        const run = runners.artifactHub;
        jobs.push(
            new Cron(schedules.artifactHub, { ...cronOptions, name: "artifacthub-sync" }, async () => {
                const result = await run(false);
                log.info({ skipped: result.skipped, reason: result.reason }, "Artifact Hub sync finished");
            }),
        );
    }

    log.info(
        {
            schedules,
            artifactHub: Boolean(runners.artifactHub),
            next: Object.fromEntries(jobs.map((job) => [job.name, job.nextRun()])),
        },
        "Sync scheduler started",
    );

    // Not awaited by the caller: the server listens first, and a fresh
    // install's bootstrap runs behind the readiness probe, not in front of it.
    const startup = runStartupSyncs(runners).then((outcome) => {
        log.info(outcome, "Start-up sync pass finished");
        return outcome;
    });

    return {
        runners,
        startup,
        async stop(): Promise<void> {
            for (const job of jobs) job.stop();
            await osv?.close();
        },
    };
}
