/**
 * The job worker: polls the `jobs` table and runs what is ready, with the
 * housekeeping crons around it (cleanup, metrics, image GC, chart repo and
 * render sweeps, the alert pass, the image-layer and base-image passes).
 *
 * Two hosts run it (`src/topology.ts`): `dist/src/worker.js` as its own
 * process in the split topology, and the HTTP server itself in the
 * monolith. Everything below is topology-agnostic; only the signal handling
 * differs, and that lives with the host.
 *
 * Environment variables:
 *   JOB_POLL_INTERVAL_MS       How often to poll for new jobs (default: 5000)
 *   JOB_BATCH_SIZE             Max jobs to process per poll (default: 5)
 *   JOB_STALE_TIMEOUT_MS       Time before a running job is considered stale (default: 1800000)
 *   JOB_STALE_CHECK_INTERVAL_MS How often, between polls, stale jobs are looked for (default: 60000)
 *   CLEANUP_CRON               Cron expression for job cleanup (default: "0 * * * *" — hourly)
 *   ALERT_CRON                 Cron expression for the critical/KEV alert pass (default: every five minutes)
 *   DIGEST_CRON                Cron expression for the weekly digest email (cloud edition only; default: Monday 07:05 UTC)
 *   ALERT_QUIET_MINUTES        Minutes a burst of qualifying events must be quiet before it is sent (default: 10)
 *   ALERT_MAX_DELAY_MINUTES    Longest a pending alert waits for a burst to end (default: 60)
 *   METRICS_CRON               Cron expression for metrics capture (default: "0 * * * *" — hourly)
 *   IMAGE_GC_CRON              Cron expression for orphaned-image GC (default: "30 3 * * *" — daily)
 *   CHART_REPO_SYNC_CRON       Cron expression for chart repository index sync (default: "45 4 * * *" — daily)
 *   CHART_RENDER_CRON          Cron expression for candidate chart render selection (default: "15 5 * * *" — daily)
 *   IMAGE_LAYER_BACKFILL_CRON  Cron expression for the image-layer registry backfill (default: "50 5 * * *" — daily)
 *   IMAGE_LAYER_BACKFILL_LIMIT Images one backfill run asks a registry about (default: 50)
 *   BASE_RERESOLVE_LIMIT       Images with an unknown base boundary re-examined per run (default: 500)
 *   BASE_CHECK_LIMIT           Base refs checked for a newer tag per run (default: 30)
 *   BASE_REGISTRY_BUDGET       Registry manifest lookups one run may spend naming and counting bases (default: 40)
 *   IMAGE_GC_RETENTION_DAYS    Floor on how long an unreferenced image is kept (default: 30);
 *                              paid plans keep theirs for the plan's historyDays window instead
 *   IMAGE_GC_BATCH_LIMIT       Max images collected per GC run (default: 500)
 */

import { Cron } from "croner";
import { backfillImageLayers } from "../services/image-layer-backfill.service.js";
import { reresolveBases } from "../services/base-image.service.js";
import { refreshBaseChecks } from "../services/base-upgrade.service.js";
import { jobService } from "../services/job.service.js";
import { metricsService } from "../services/metrics.service.js";
import { alertService } from "../services/alert.service.js";
import { syncChartRepositories } from "../services/chart-repo.service.js";
import { enqueueCandidateRenders } from "../chart-render/selection.js";
import { enqueueMissingPlatformScans } from "../platform-scan/scan-job.js";
import { jobRepository } from "../repositories/job.repository.js";
import { deleteOrphanedImages } from "../repositories/delete-helpers.js";
import { IMAGE_GC_RETENTION_DAYS } from "../config/image-gc.js";
import { createLogger } from "../lib/logger.js";
import { edition } from "../edition.js";
import { enableCloud, scheduleCloudJobs } from "../cloud/index.js";

const log = createLogger("job-worker");

function resolveEnv(key: string, defaultValue: string): string {
    return process.env[key] ?? defaultValue;
}

function resolveEnvNum(key: string, defaultValue: number): number {
    return Number(process.env[key]) || defaultValue;
}

function configEntry(key: string, value: string | number): { value: string | number; source: "env" | "default" } {
    return { value, source: key in process.env ? "env" : "default" };
}

const POLL_INTERVAL_MS = resolveEnvNum("JOB_POLL_INTERVAL_MS", 5_000);
const BATCH_SIZE = resolveEnvNum("JOB_BATCH_SIZE", 5);
const STALE_JOB_TIMEOUT_MS = resolveEnvNum("JOB_STALE_TIMEOUT_MS", 30 * 60 * 1_000);
// Stale recovery used to run at startup only. A job claimed seconds before
// the worker was killed (2026-09-10, OOM) is not yet stale when the
// replacement boots, and nothing looked at it again — it stayed `processing`
// indefinitely, and the nightly sweep treated it as covered. Between polls
// nothing is in flight in this process, so the check is safe to repeat.
const STALE_CHECK_INTERVAL_MS = resolveEnvNum("JOB_STALE_CHECK_INTERVAL_MS", 60 * 1_000);
const CLEANUP_CRON = resolveEnv("CLEANUP_CRON", "0 * * * *");
const METRICS_CRON = resolveEnv("METRICS_CRON", "0 * * * *");
// Daily, not hourly: the sweep only has work after a cluster is deleted or an
// image falls out of the fleet for a month, and its unit of work is a whole
// component subtree. Off the hour so it never lands on top of the other two.
const IMAGE_GC_CRON = resolveEnv("IMAGE_GC_CRON", "30 3 * * *");
// Daily: index.yaml changes on a chart publish, and the fetch is conditional
// (ETag) so an unchanged index costs one 304. Off the other crons' minutes.
// The Artifact Hub sync (a Kubernetes CronJob in the gitops repo, 02:15) runs
// deliberately BEFORE this: its attribution pass auto-adds chart repositories,
// and running first means they get their index.yaml synced the same night.
// Keep this after 02:15 unless that CronJob's schedule moves too.
const CHART_REPO_SYNC_CRON = resolveEnv("CHART_REPO_SYNC_CRON", "45 4 * * *");
// After the 04:45 index sync, so tonight's tarball URLs are tonight's renders.
// The pass only *selects and enqueues* (bounded by CHART_RENDER_MAX_PER_RUN);
// the poll loop below is what actually renders and scans, so a slow chart
// never blocks the cron. See docs/proposals/measuring-candidate-charts.md.
const CHART_RENDER_CRON = resolveEnv("CHART_RENDER_CRON", "15 5 * * *");
// Bounds one run, so a large first sweep is spread over several nights rather
// than holding the connection for hours.
const IMAGE_GC_BATCH_LIMIT = resolveEnvNum("IMAGE_GC_BATCH_LIMIT", 500);
// Monday 07:00 UTC: the weekly digest email (services/digest.service.ts).
// After the 07:00 metrics snapshot would be ideal but they share the hour;
// the digest reads the live rollup, not the snapshot, so the order is moot.
const DIGEST_CRON = resolveEnv("DIGEST_CRON", "5 7 * * 1");
// Every five minutes: the critical & KEV alert pass (services/alert.service.ts).
// The pass itself is a couple of indexed reads per eligible org and sends
// nothing until a burst of qualifying events has been quiet for
// ALERT_QUIET_MINUTES, so a tight schedule costs little and is what keeps
// "within minutes" true.
const ALERT_CRON = resolveEnv("ALERT_CRON", "*/5 * * * *");
const ALERT_QUIET_MS = resolveEnvNum("ALERT_QUIET_MINUTES", 10) * 60 * 1_000;
const ALERT_MAX_DELAY_MS = resolveEnvNum("ALERT_MAX_DELAY_MINUTES", 60) * 60 * 1_000;
// Layer lists for public images scanned before the scanner sent them
// (services/image-layer-backfill.service.ts). Bounded per run because every
// image is a manifest GET, which Docker Hub counts; a 429 ends the run. Once
// every stored image has layers — or a scanner ≥ 0.4.0 has rescanned it —
// the pass selects nothing and costs one query.
const IMAGE_LAYER_BACKFILL_CRON = resolveEnv("IMAGE_LAYER_BACKFILL_CRON", "50 5 * * *");
const IMAGE_LAYER_BACKFILL_LIMIT = resolveEnvNum("IMAGE_LAYER_BACKFILL_LIMIT", 50);
// Base boundaries (services/base-image.service.ts): how many undecided images
// one run re-examines, and how many registry manifests it may ask for.
const BASE_RERESOLVE_LIMIT = resolveEnvNum("BASE_RERESOLVE_LIMIT", 500);
const BASE_REGISTRY_BUDGET = resolveEnvNum("BASE_REGISTRY_BUDGET", 40);
// Base refs one run asks a registry about (services/base-upgrade.service.ts):
// a tag list and two manifest reads each.
const BASE_CHECK_LIMIT = resolveEnvNum("BASE_CHECK_LIMIT", 30);

async function recoverStaleJobs(): Promise<void> {
    try {
        const staleJobs = await jobRepository.findAllProcessing();
        const now = Date.now();

        for (const job of staleJobs) {
            if (!job.startedAt) continue;
            const elapsed = now - job.startedAt.getTime();
            if (elapsed > STALE_JOB_TIMEOUT_MS) {
                log.warn(
                    { jobId: job.id, type: job.type, startedAt: job.startedAt, elapsedMs: elapsed },
                    "Recovering stale job"
                );
                await jobRepository.fail(job.id, "STALE_TIMEOUT", "Job timed out and was recovered by worker");
            }
        }
    } catch (error) {
        log.error({ error }, "Failed to recover stale jobs");
    }
}

async function pollOnce(): Promise<number> {
    try {
        const processed = await jobService.processReadyJobs(BATCH_SIZE);
        if (processed > 0) {
            log.info({ processed }, "Processed jobs");
        }
        return processed;
    } catch (error) {
        log.error({ error }, "Error during job processing poll");
        return 0;
    }
}

export interface JobWorkerHandle {
    /** Ask the loop to stop after the poll in progress; `done` resolves once it has. */
    stop(): void;
    done: Promise<void>;
}

/**
 * One poll of the queue plus the stale-job sweep — `worker --once`, and what
 * the monolith's tests drive.
 */
export async function runJobWorkerOnce(): Promise<number> {
    await recoverStaleJobs();
    return pollOnce();
}

/**
 * Start the worker loop and its crons. Returns a handle rather than a
 * promise that resolves at exit, because the monolith (`src/topology.ts`)
 * runs this inside the HTTP server's process and needs to stop it on
 * SIGTERM alongside the listener; `dist/src/worker.js` is the same call
 * with the process's own signal handlers around it.
 */
export function startJobWorker(): JobWorkerHandle {
    let running = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;

    const done = startPolling();
    return {
        stop() {
            running = false;
            if (pollTimer) {
                clearTimeout(pollTimer);
                pollTimer = null;
            }
            wake?.();
        },
        done,
    };

    async function startPolling(): Promise<void> {
    log.info(
        {
            config: {
                JOB_POLL_INTERVAL_MS: configEntry("JOB_POLL_INTERVAL_MS", POLL_INTERVAL_MS),
                JOB_BATCH_SIZE: configEntry("JOB_BATCH_SIZE", BATCH_SIZE),
                JOB_STALE_TIMEOUT_MS: configEntry("JOB_STALE_TIMEOUT_MS", STALE_JOB_TIMEOUT_MS),
                JOB_STALE_CHECK_INTERVAL_MS: configEntry("JOB_STALE_CHECK_INTERVAL_MS", STALE_CHECK_INTERVAL_MS),
                CLEANUP_CRON: configEntry("CLEANUP_CRON", CLEANUP_CRON),
                METRICS_CRON: configEntry("METRICS_CRON", METRICS_CRON),
                IMAGE_GC_CRON: configEntry("IMAGE_GC_CRON", IMAGE_GC_CRON),
                IMAGE_GC_RETENTION_DAYS: configEntry("IMAGE_GC_RETENTION_DAYS", IMAGE_GC_RETENTION_DAYS),
                IMAGE_GC_BATCH_LIMIT: configEntry("IMAGE_GC_BATCH_LIMIT", IMAGE_GC_BATCH_LIMIT),
                CHART_REPO_SYNC_CRON: configEntry("CHART_REPO_SYNC_CRON", CHART_REPO_SYNC_CRON),
                CHART_RENDER_CRON: configEntry("CHART_RENDER_CRON", CHART_RENDER_CRON),
                DIGEST_CRON: configEntry("DIGEST_CRON", DIGEST_CRON),
                ALERT_CRON: configEntry("ALERT_CRON", ALERT_CRON),
                ALERT_QUIET_MINUTES: configEntry("ALERT_QUIET_MINUTES", ALERT_QUIET_MS / 60_000),
                ALERT_MAX_DELAY_MINUTES: configEntry("ALERT_MAX_DELAY_MINUTES", ALERT_MAX_DELAY_MS / 60_000),
            },
            edition: edition.edition,
        },
        "Job worker started"
    );

    await recoverStaleJobs();

    const cleanupJob = new Cron(CLEANUP_CRON, { name: "cleanup", catch: true }, async () => {
        try {
            const cleaned = await jobService.cleanup();
            if (cleaned > 0) {
                log.info({ cleaned }, "Cleaned up old jobs");
            }
        } catch (error) {
            log.error({ error }, "Failed to clean up old jobs");
        }
    });

    const metricsJob = new Cron(METRICS_CRON, { name: "metrics", catch: true }, async () => {
        try {
            const [capturedOrgs, capturedClusters] = await Promise.all([
                metricsService.captureAllOrgs(),
                metricsService.captureAllClusters(),
            ]);
            log.info({ capturedOrgs, capturedClusters }, "Captured metrics snapshots");
            await metricsService.cleanup();
        } catch (error) {
            log.error({ error }, "Failed to capture metrics snapshots");
        }
    });

    const chartRepoJob = new Cron(CHART_REPO_SYNC_CRON, { name: "chart-repo-sync", catch: true }, async () => {
        try {
            const stats = await syncChartRepositories();
            log.info(stats, "Synced chart repository indexes");
        } catch (error) {
            log.error({ error }, "Failed to sync chart repositories");
        }
    });

    const chartRenderJob = new Cron(CHART_RENDER_CRON, { name: "chart-render", catch: true }, async () => {
        try {
            const stats = await enqueueCandidateRenders();
            const sweptScans = await enqueueMissingPlatformScans();
            log.info({ ...stats, sweptScans }, "Queued candidate chart renders");
        } catch (error) {
            log.error({ error }, "Failed to queue candidate chart renders");
        }
    });

    const imageGcJob = new Cron(IMAGE_GC_CRON, { name: "image-gc", catch: true }, async () => {
        try {
            // The window is per-org now — the plan's history window, floored
            // by IMAGE_GC_RETENTION_DAYS — and lives inside the sweep's SQL.
            const collected = await deleteOrphanedImages(IMAGE_GC_BATCH_LIMIT);
            if (collected > 0) {
                // Logged even though it is routine: this is the only path that
                // destroys stored SBOMs, so a surprising count needs to be
                // visible after the fact rather than inferred from disk use.
                log.info(
                    { collected, floorDays: IMAGE_GC_RETENTION_DAYS, limit: IMAGE_GC_BATCH_LIMIT },
                    "Collected orphaned images"
                );
            }
        } catch (error) {
            log.error({ error }, "Failed to collect orphaned images");
        }
    });

    // The cloud's own crons (the weekly digest email) and its email channel
    // for the alert pass below. In the community edition this is nothing:
    // alerts go to the org's webhook and there is no digest.
    const cloudJobs = edition.isCloud ? (enableCloud(), scheduleCloudJobs({ digestCron: DIGEST_CRON })) : [];

    const alertJob = new Cron(ALERT_CRON, { name: "alerts", catch: true, protect: true }, async () => {
        try {
            await alertService.runPass(new Date(), { quietMs: ALERT_QUIET_MS, maxDelayMs: ALERT_MAX_DELAY_MS });
        } catch (error) {
            log.error({ error }, "Alert pass failed");
        }
    });

    const layerBackfillJob = new Cron(IMAGE_LAYER_BACKFILL_CRON, { name: "image-layer-backfill", catch: true }, async () => {
        try {
            const stats = await backfillImageLayers(IMAGE_LAYER_BACKFILL_LIMIT, {
                timeoutMs: 15_000,
                userAgent: "sbom-tracker-layer-backfill/1.0",
            });
            if (stats.candidates > 0) log.info(stats, "Backfilled image layers from registries");
        } catch (error) {
            log.error({ error }, "Failed to backfill image layers");
        }
        // Same cron, after it: the layers it just filled are what this reads.
        // Images whose base boundary is still unknown are re-resolved against
        // tonight's known-prefix table, and a bounded number of bases are
        // counted or verified against their public registry.
        // Then what each known base could be rebuilt on: today's digest of
        // its tag and the newest comparable newer tag, both queued for the
        // platform scanner so the recommendation can be measured.
        try {
            const stats = await refreshBaseChecks(BASE_CHECK_LIMIT, {
                timeoutMs: 15_000,
                userAgent: "sbom-tracker-base-image/1.0",
            });
            if (stats.bases > 0) log.info(stats, "Checked base images for newer tags");
        } catch (error) {
            log.error({ error }, "Failed to check base images for newer tags");
        }
        try {
            const stats = await reresolveBases(BASE_RERESOLVE_LIMIT, BASE_REGISTRY_BUDGET, {
                timeoutMs: 15_000,
                userAgent: "sbom-tracker-base-image/1.0",
            });
            if (stats.examined > 0) log.info(stats, "Re-resolved base image boundaries");
        } catch (error) {
            log.error({ error }, "Failed to re-resolve base image boundaries");
        }
    });

    log.info(
        {
            cleanupNext: cleanupJob.nextRun(),
            metricsNext: metricsJob.nextRun(),
            imageGcNext: imageGcJob.nextRun(),
            chartRepoNext: chartRepoJob.nextRun(),
            chartRenderNext: chartRenderJob.nextRun(),
            digestNext: cloudJobs.find((j) => j.name === "weekly-digest")?.nextRun() ?? null,
            alertNext: alertJob.nextRun(),
            layerBackfillNext: layerBackfillJob.nextRun(),
        },
        "Cron jobs scheduled"
    );

    let lastStaleCheck = Date.now();
    while (running) {
        await pollOnce();

        if (running && Date.now() - lastStaleCheck >= STALE_CHECK_INTERVAL_MS) {
            await recoverStaleJobs();
            lastStaleCheck = Date.now();
        }

        if (running) {
            await new Promise<void>((resolve) => {
                wake = resolve;
                pollTimer = setTimeout(resolve, POLL_INTERVAL_MS);
            });
            wake = null;
        }
    }

    cleanupJob.stop();
    metricsJob.stop();
    imageGcJob.stop();
    chartRepoJob.stop();
    chartRenderJob.stop();
    for (const job of cloudJobs) job.stop();
    alertJob.stop();
    layerBackfillJob.stop();
    }
}

