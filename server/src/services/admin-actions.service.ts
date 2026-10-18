/**
 * The admin page's actions: the triggers its readings imply.
 *
 * Every one is admin-only, idempotent, refuses while the same action is
 * already in progress in this process, and runs the existing code path
 * rather than a second one — the scheduler's own runners for the feeds
 * (`sync-scheduler.ts`), the nightly sweep for the image GC
 * (`deleteOrphanedImages`), the mirror sync's enqueue for the fleet rescan
 * (`osv-sync/rescan.ts`), the job table for a retry. So a click and a cron
 * can never overlap: the OSV worker holds a session advisory lock per run
 * and EPSS/KEV a transaction lock on their apply, and a click that loses
 * that race is answered as skipped, exactly as a second CronJob would be.
 *
 * Topology decides what a feed trigger can do. The monolith has the runners
 * in-process and runs them here, in the background, answering 202. The
 * split topology's API process has no runner — the syncs are external
 * CronJobs — so it answers 409 naming the CronJob to run instead. The
 * database-only actions (GC, rescan, retry) work in both.
 *
 * None of these writes `activity_events`: the feed carries changes to
 * findings, not operator actions. Each is logged at info with the acting
 * user instead.
 */

import { AppError } from "../middleware/error-handler.js";
import { createLogger } from "../lib/logger.js";
import { topology as processTopology, type Topology } from "../topology.js";
import { IMAGE_GC_BATCH_LIMIT } from "../config/image-gc.js";
import { deleteOrphanedImages } from "../repositories/delete-helpers.js";
import { jobRepository } from "../repositories/job.repository.js";
import { enqueueFleetRescan } from "../osv-sync/rescan.js";
import type { SyncRunners } from "../sync-scheduler.js";
import type { Job } from "../db/schema/jobs.js";

const log = createLogger("admin-actions");

export type SyncAction = "osv-sync" | "osv-bootstrap" | "epss" | "kev" | "artifacthub";

/** The CronJob a split-topology operator runs by hand, per action — the same CLIs the scheduler wraps. */
export const SYNC_ACTION_CRONJOB: Record<SyncAction, string> = {
    "osv-sync": "osv-sync",
    "osv-bootstrap": "osv-bootstrap",
    epss: "epss-sync",
    kev: "kev-sync",
    artifacthub: "artifacthub-sync",
};

export class AdminActionInProgressError extends AppError {
    constructor(
        readonly action: string,
        readonly startedAt: Date,
    ) {
        super(409, `${action} is already running (started ${startedAt.toISOString()})`, true, "in_progress");
        // AppError pins its own prototype in its constructor; a subclass has to pin its own back.
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = "AdminActionInProgressError";
    }
}

export class AdminActionUnavailableError extends AppError {
    constructor(
        readonly action: SyncAction,
        readonly reason: "not_available_in_split" | "disabled",
    ) {
        super(
            409,
            reason === "not_available_in_split"
                ? `${action} cannot run from the API in the split topology; run the ${SYNC_ACTION_CRONJOB[action]} CronJob instead`
                : `${action} is switched off in this install (ARTIFACT_HUB_SYNC_ENABLED=false)`,
            true,
            reason,
        );
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = "AdminActionUnavailableError";
    }
}

export interface AdminActionDeps {
    topology: Topology;
    runners: SyncRunners | null;
}

let registeredRunners: SyncRunners | null = null;

/** Called once by the monolith's start-up with the scheduler's runners. The split topology never calls it. */
export function registerSyncRunners(runners: SyncRunners): void {
    registeredRunners = runners;
}

const defaultDeps = (): AdminActionDeps => ({ topology: processTopology, runners: registeredRunners });

/**
 * One run per action per process. The map is the only state here; the
 * cross-process guard is the database lock each runner already takes.
 */
const inFlight = new Map<string, { startedAt: Date }>();

export function actionInFlight(action: string): { startedAt: Date } | null {
    return inFlight.get(action) ?? null;
}

function guard<T>(action: string, run: () => Promise<T>): Promise<T> {
    const running = inFlight.get(action);
    if (running) throw new AdminActionInProgressError(action, running.startedAt);
    inFlight.set(action, { startedAt: new Date() });
    return run().finally(() => inFlight.delete(action));
}

export interface TriggeredSync {
    action: SyncAction;
    startedAt: string;
}

/**
 * Start a feed run in the background and answer at once: a bootstrap is
 * minutes, and the OSV tab's state row is where its progress shows. The
 * outcome is logged when it lands. The guard is taken synchronously, so
 * two clicks in the same tick get one run and one 409.
 */
export function triggerSync(action: SyncAction, actor: string, deps: AdminActionDeps = defaultDeps()): TriggeredSync {
    if (deps.topology === "split" || !deps.runners) {
        throw new AdminActionUnavailableError(action, "not_available_in_split");
    }
    const runners = deps.runners;
    const run = (): Promise<unknown> => {
        switch (action) {
            case "osv-sync":
                return runners.osv.runCycle();
            case "osv-bootstrap":
                return runners.osv.bootstrapIfNeeded();
            case "epss":
                // Forced: a click is a person asking for a run, and the daily
                // freshness guard would otherwise answer "already done today".
                return runners.epss(true);
            case "kev":
                return runners.kev(true);
            case "artifacthub":
                if (!runners.artifactHub) throw new AdminActionUnavailableError(action, "disabled");
                return runners.artifactHub(true);
        }
    };

    const running = inFlight.get(action);
    if (running) throw new AdminActionInProgressError(action, running.startedAt);
    if (action === "artifacthub" && !runners.artifactHub) throw new AdminActionUnavailableError(action, "disabled");

    const startedAt = new Date();
    log.info({ action, actor }, "Admin triggered a sync");
    void guard(action, run)
        .then((result) => log.info({ action, actor, result }, "Admin-triggered sync finished"))
        .catch((error: unknown) => log.error({ action, actor, err: error }, "Admin-triggered sync failed"));
    return { action, startedAt: startedAt.toISOString() };
}

/** The nightly sweep, now. Awaited: it is bounded by the same batch cap the cron uses. */
export async function collectOrphanedImages(actor: string): Promise<{ collected: number; limit: number }> {
    return guard("image-gc", async () => {
        const collected = await deleteOrphanedImages(IMAGE_GC_BATCH_LIMIT);
        log.info({ actor, collected, limit: IMAGE_GC_BATCH_LIMIT }, "Admin collected orphaned images");
        return { collected, limit: IMAGE_GC_BATCH_LIMIT };
    });
}

/** A `scheduled_scan` for every image with an SBOM and no scan already open. */
export async function rescanFleet(actor: string): Promise<{ enqueued: number }> {
    return guard("rescan", async () => {
        const enqueued = await enqueueFleetRescan("manual");
        log.info({ actor, enqueued }, "Admin queued a fleet rescan");
        return { enqueued };
    });
}

export async function retryJob(id: string, actor: string): Promise<Job> {
    const job = await jobRepository.resetForRetry(id);
    if (!job) {
        const existing = await jobRepository.findById(id);
        if (!existing) throw new AppError(404, "Job not found");
        throw new AppError(409, `Only a failed job can be retried; this one is ${existing.status}`);
    }
    log.info({ actor, jobId: id, type: job.type }, "Admin retried a job");
    return job;
}

export async function retryStuckJobs(actor: string): Promise<{ retried: number }> {
    return guard("retry-stuck", async () => {
        const retried = await jobRepository.resetAllStuck();
        log.info({ actor, retried }, "Admin retried every job that was out of retries");
        return { retried };
    });
}
