import { jobRepository } from "../repositories/job.repository.js";
import { JobFailure } from "../lib/job-failure.js";
import {
    countByBucket,
    countByLens,
    countBySeverity,
    type ComparableFinding,
    type FindingDelta,
} from "../db/finding-delta.js";
import { passesLens } from "../db/finding-tier.js";
import { imageRepository } from "../repositories/image.repository.js";
import { sbomRepository } from "../repositories/sbom.repository.js";
import { vulnerabilityRepository } from "../repositories/vulnerability.repository.js";
import { vulnerabilityScanRunRepository } from "../repositories/vulnerability-scan-run.repository.js";
import { remediationRepository } from "../repositories/remediation.repository.js";
import { backfillMoveDeltas } from "../repositories/container-history.repository.js";
import { vulnerabilitySyncService, OsvMirrorNotReadyError } from "./vulnerability-sync.service.js";
import { metricsService } from "./metrics.service.js";
import { createLogger } from "../lib/logger.js";
import type { Job, NewJob, JobType, JobTrigger } from "../db/schema/jobs.js";

/** Job types that scan an image's SBOM against the OSV mirror. */
const SCAN_JOB_TYPES: ReadonlySet<JobType> = new Set(["vulnerability_scan", "scheduled_scan"]);

/**
 * Put this scan's results into the trend store — see
 * `metricsService.refreshSnapshots`. Runs on every scan completion, which is
 * what lets a first install's chart start immediately and then keep up as the
 * rest of its workloads land.
 *
 * Best-effort, like `recordScanRun`: the scan itself has already succeeded and
 * must not be failed by a trend-store write.
 */
async function updateSnapshotsForScan(job: Job): Promise<void> {
    if (!job.imageId) return;
    try {
        /* Every cluster running this image, not one. An image is shared by
           design, so a scan of it moves the numbers on each cluster page that
           shows it — refreshing only the "owning" cluster would leave the
           others stale, and after the cutover there is no owning cluster to
           pick. */
        const deployments = await imageRepository.findDeployments(job.imageId, job.orgId);
        const clusterIds = [...new Set(deployments.map((d) => d.clusterId))];
        for (const clusterId of clusterIds) {
            await metricsService.refreshSnapshots(job.orgId, clusterId);
        }
    } catch (error) {
        log.error({ error, jobId: job.id, imageId: job.imageId }, "Failed to update metrics snapshots");
    }
}

/**
 * Record a durable vulnerability scan run for an image after a scan job
 * finishes. Lives in the `vulnerability_scan_runs` domain table (not `jobs`)
 * so the history survives worker-queue cleanup. Best-effort: a failure here is
 * logged but never propagated, so it can't break job completion.
 */
async function recordScanRun(
    job: Job,
    outcome:
        | { status: "success"; componentsScanned: number; delta: FindingDelta | null }
        | { status: "failed"; errorMessage: string },
): Promise<void> {
    if (!job.imageId) return;
    try {
        const sbomId = job.sbomId ?? (await sbomRepository.findByImageId(job.imageId))?.id ?? null;
        const counts =
            outcome.status === "success" && sbomId
                ? await vulnerabilityRepository.getSeverityCountsBySbomId(sbomId)
                : { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
        const osvMirrorSyncedAt = await vulnerabilityScanRunRepository.getOsvMirrorWatermark();

        /*
         * The activity feed carries changes, not inventory: one event when a
         * scan finds more criticals on a running image than its previous scan
         * did — never one entry per finding. Read the previous run before this
         * one is written, so the comparison is scan-to-scan.
         */
        const previous = (await vulnerabilityScanRunRepository.findByImageId(job.imageId, 5)).find(
            (run) => run.status === "success",
        );

        const completedAt = new Date();
        const startedAt = job.startedAt ?? null;

        await vulnerabilityScanRunRepository.create({
            orgId: job.orgId,
            imageId: job.imageId,
            sbomId,
            jobId: job.id,
            trigger: job.triggeredBy,
            status: outcome.status,
            componentsScanned: outcome.status === "success" ? outcome.componentsScanned : 0,
            vulnsFound: counts.total,
            critical: counts.critical,
            high: counts.high,
            medium: counts.medium,
            low: counts.low,
            osvMirrorSyncedAt,
            errorMessage: outcome.status === "failed" ? outcome.errorMessage : null,
            startedAt,
            completedAt,
            durationMs: startedAt ? completedAt.getTime() - startedAt.getTime() : null,
        });

        const firstScan = previous == null;
        if (outcome.status === "success" && outcome.delta) {
            await recordFindingsChanged(job, outcome.delta, firstScan);
        }

        /*
         * The inventory report usually lands minutes before the new digest's
         * first scan, so the moves *to* this image were written unmeasured.
         * Now that the image has findings, measure them.
         */
        if (outcome.status === "success" && firstScan) {
            await backfillMoveDeltas(job.imageId);
        }

        if (outcome.status === "success" && previous != null && counts.critical > previous.critical) {
            const image = await imageRepository.findById(job.imageId);
            await remediationRepository.appendEvent({
                orgId: job.orgId,
                clusterId: image?.clusterId ?? null,
                type: "scan.criticals-increased",
                imageId: job.imageId,
                payload: {
                    repository: image?.repository ?? null,
                    digest: image?.digest ?? null,
                    criticalsBefore: previous.critical,
                    criticalsAfter: counts.critical,
                    vulnsFound: counts.total,
                },
            });
        }
    } catch (err) {
        log.error({ jobId: job.id, err }, "Failed to record vulnerability scan run");
    }
}

/**
 * How many of a scan's added / removed findings ride in the event payload.
 * The counts are always exact; the lists are the head of each, worst first,
 * so a four-hundred-finding base image bump does not put four hundred rows
 * of jsonb behind one feed line.
 */
const FINDINGS_IN_PAYLOAD = 100;

const findingLine = (f: ComparableFinding) => ({
    key: f.key,
    vulnId: f.vulnId,
    packageName: f.packageName,
    packageType: f.packageType,
    packageVersion: f.packageVersion,
    severityLevel: f.severityLevel,
    riskScore: f.riskScore,
    kevListed: f.kevListed,
    fixedVersion: f.fixedVersion,
    // For the movement block's `?tier=`: the bucket, and whether the
    // exploited override keeps the line under a lens that excludes it.
    bucket: f.bucket,
    exploited: passesLens(f, []),
});

/** How many of the slots running an image ride in a scan event's payload. */
const CONTAINERS_IN_PAYLOAD = 25;

/**
 * `scan.findings-changed`. One event per (image,
 * scan), carrying the added and removed keys, and nothing when nothing
 * changed. The `cause` is what the reader's next action turns on: `mirror`
 * means the world changed (an advisory published or withdrawn against a
 * digest already running; nothing was deployed), `upload` means we changed
 * (a `?replace=true` re-upload of the same digest — `replaced: true` says
 * so), and `first-scan` means the image had no findings before because it
 * had never been scanned. A first scan is inventory, not change: the
 * findings did not arrive that day, the image did, and the move that
 * brought it carries the real delta (§4). The event still exists so the
 * log says what happened, but the Feed page does not show it.
 *
 * The slots running the image ride in the payload so a line can name the
 * workloads that gained or lost findings rather than the repository they
 * happen to share — the reader tracks workloads, not digests.
 */
async function recordFindingsChanged(job: Job, delta: FindingDelta, firstScan: boolean): Promise<void> {
    if (!job.imageId) return;
    if (delta.resolved.length === 0 && delta.introduced.length === 0 && delta.rescored.length === 0) return;

    const image = await imageRepository.findById(job.imageId);
    const cause = firstScan ? "first-scan" : job.triggeredBy === "sbom_upload" ? "upload" : "mirror";
    const deployments = await imageRepository.findDeployments(job.imageId, job.orgId);
    await remediationRepository.appendEvent({
        orgId: job.orgId,
        clusterId: image?.clusterId ?? null,
        type: "scan.findings-changed",
        imageId: job.imageId,
        payload: {
            cause,
            replaced: cause === "upload" && job.params?.replaced === true,
            repository: image?.repository ?? null,
            digest: image?.digest ?? null,
            containerCount: deployments.length,
            containers: deployments.slice(0, CONTAINERS_IN_PAYLOAD).map((d) => ({
                namespace: d.namespaceName,
                workloadKind: d.workloadKind,
                workloadName: d.workloadName,
                containerName: d.containerName,
                init: d.init,
            })),
            addedCount: delta.introduced.length,
            removedCount: delta.resolved.length,
            unchangedCount: delta.unchanged.length,
            rescoredCount: delta.rescored.length,
            // Exact per-band counts: the lists below are truncated, these are not.
            addedBySeverity: countBySeverity(delta.introduced),
            removedBySeverity: countBySeverity(delta.resolved),
            // The same counts under each tier lens (`finding-tier.ts`).
            addedByLens: countByLens(delta.introduced),
            // Scored arrivals per plain bucket — the digest's "N new in base images".
            addedByBucket: countByBucket(delta.introduced),
            // Rescored findings, by the band they moved *into* and the one they left.
            rescoredToBySeverity: countBySeverity(delta.rescored),
            rescoredFromBySeverity: countBySeverity(delta.rescored, (f) => f.previousSeverityLevel),
            added: delta.introduced.slice(0, FINDINGS_IN_PAYLOAD).map(findingLine),
            removed: delta.resolved.slice(0, FINDINGS_IN_PAYLOAD).map(findingLine),
            rescored: delta.rescored.slice(0, FINDINGS_IN_PAYLOAD).map((f) => ({
                ...findingLine(f),
                previousSeverityLevel: f.previousSeverityLevel,
            })),
            riskBefore: delta.riskBefore,
            riskAfter: delta.riskAfter,
        },
    });
}

const log = createLogger("job-service");

export interface CreateJobInput {
    orgId: string;
    imageId?: string | undefined;
    sbomId?: string | undefined;
    type: JobType;
    title?: string | undefined;
    triggeredBy?: JobTrigger | undefined;
    scheduledFor?: Date | undefined;
    priority?: number | undefined;
    params?: Record<string, unknown> | undefined;
}

export interface JobListResult {
    jobs: Job[];
}

/**
 * Generate a human-readable title for a job
 */
function generateJobTitle(type: JobType, subject?: string): string {
    const prefix = subject ? `${subject}: ` : "";
    switch (type) {
        case "vulnerability_scan":
            return `${prefix}Vulnerability Scan`;
        case "full_sync":
            return "Full Vulnerability Sync";
        case "scheduled_scan":
            return `${prefix}Scheduled Security Scan`;
        case "chart_render":
            return `${prefix}Chart Render`;
        case "platform_scan":
            return `${prefix}Platform Scan`;
        case "chart_repo_refresh":
            return `${prefix}Chart Repository Refresh`;
        case "tier_reclassify":
            return "Reclassify packages after a rule change";
    }
}

export const jobService = {
    /**
     * Create a new job
     */
    async createJob(input: CreateJobInput): Promise<Job> {
        /* Title the job after the image it is about. `repository@short-digest`
           rather than a workload name: one scan covers every workload running
           the digest, and naming one of them would be arbitrary. */
        let subject: string | undefined;
        if (input.imageId) {
            const image = await imageRepository.findById(input.imageId);
            if (image) {
                subject = `${image.repository ?? image.registry ?? "image"}@${image.digest.slice(0, 19)}`;
            }
        }

        const title = input.title ?? generateJobTitle(input.type, subject);

        const newJob: NewJob = {
            orgId: input.orgId,
            imageId: input.imageId,
            sbomId: input.sbomId,
            type: input.type,
            title,
            triggeredBy: input.triggeredBy ?? "manual",
            scheduledFor: input.scheduledFor,
            priority: input.priority ?? 0,
            params: input.params,
        };

        const job = await jobRepository.create(newJob);
        log.info({ jobId: job.id, type: job.type, imageId: job.imageId }, "Job created");

        return job;
    },

    /**
     * Queue a vulnerability scan for an image.
     *
     * One job per image, not per workload — the whole point of the cutover.
     */
    async queueVulnerabilityScan(
        orgId: string,
        imageId: string,
        sbomId?: string,
        triggeredBy?: JobTrigger,
        /** `{ replaced: true }` when the upload superseded an SBOM — the feed says so. */
        params?: Record<string, unknown>,
    ): Promise<Job> {
        return this.createJob({
            orgId,
            imageId,
            sbomId,
            type: "vulnerability_scan",
            triggeredBy: triggeredBy ?? "manual",
            priority: 5,
            params,
        });
    },

    /**
     * Get all jobs for display, sorted newest-first
     */
    async getJobsList(orgId: string): Promise<JobListResult> {
        const jobs = await jobRepository.findByOrg(orgId, { limit: 100 });
        return { jobs };
    },

    /**
     * Get a single job by ID
     */
    async getJob(id: string): Promise<Job | undefined> {
        return jobRepository.findById(id);
    },

    /**
     * Execute a job that is already in 'processing' state.
     * Called by processReadyJobs (worker).
     */
    async executeJob(job: Job): Promise<void> {
        log.info({ jobId: job.id, type: job.type }, "Starting job processing");

        try {
            let result: Record<string, unknown> | undefined;
            let scanComponentsScanned: number | null = null;
            let scanDelta: FindingDelta | null = null;

            switch (job.type) {
                case "vulnerability_scan":
                case "scheduled_scan": {
                    if (!job.imageId) {
                        throw new Error("Image ID required for vulnerability scan");
                    }
                    await jobRepository.updateProgress(job.id, 10, "Fetching components...");
                    const scanResult = await vulnerabilitySyncService.syncImageVulnerabilities(
                        job.imageId,
                        job.sbomId ?? undefined,
                    );
                    scanComponentsScanned = scanResult.componentsProcessed;
                    scanDelta = scanResult.delta;
                    result = {
                        componentsProcessed: scanResult.componentsProcessed,
                        vulnerabilitiesFound: scanResult.totalVulnerabilitiesFound,
                        sbomId: job.sbomId,
                    };
                    break;
                }

                case "full_sync": {
                    await jobRepository.updateProgress(job.id, 5, "Starting full sync...");
                    const fullResult = await vulnerabilitySyncService.syncAllComponentsVulnerabilities();
                    result = {
                        componentsProcessed: fullResult.componentsProcessed,
                        vulnerabilitiesFound: fullResult.totalVulnerabilitiesFound,
                        vulnerabilitiesLinked: fullResult.totalVulnerabilitiesLinked,
                        errors: fullResult.errors.length,
                        duration: fullResult.duration,
                    };
                    break;
                }

                case "chart_render": {
                    // Lazy import: the render module enqueues follow-up jobs
                    // through `jobRepository`, so a static import back into
                    // this service would be the start of a cycle.
                    const { runChartRenderJob } = await import("../chart-render/render-job.js");
                    await jobRepository.updateProgress(job.id, 10, "Fetching chart tarball...");
                    result = await runChartRenderJob(job.params);
                    break;
                }

                case "platform_scan": {
                    const { runPlatformScanJob } = await import("../platform-scan/scan-job.js");
                    await jobRepository.updateProgress(job.id, 10, "Pulling candidate image...");
                    result = await runPlatformScanJob(job.params);
                    break;
                }

                case "chart_repo_refresh": {
                    const { runChartRepoRefreshJob } = await import("../services/chart-repo.service.js");
                    await jobRepository.updateProgress(job.id, 10, "Fetching index.yaml...");
                    result = await runChartRepoRefreshJob(job.orgId, job.params);
                    break;
                }

                case "tier_reclassify": {
                    const { runTierReclassifyJob } = await import("./tier-rules.service.js");
                    await jobRepository.updateProgress(job.id, 10, "Reclassifying packages...");
                    result = await runTierReclassifyJob(job.orgId);
                    break;
                }

                default:
                    throw new Error(`Unknown job type: ${job.type}`);
            }

            await jobRepository.complete(job.id, result);
            log.info({ jobId: job.id, result }, "Job completed successfully");

            if (SCAN_JOB_TYPES.has(job.type) && scanComponentsScanned !== null) {
                await recordScanRun(job, {
                    status: "success",
                    componentsScanned: scanComponentsScanned,
                    delta: scanDelta,
                });
                await updateSnapshotsForScan(job);
            }
        } catch (error) {
            if (error instanceof OsvMirrorNotReadyError) {
                await jobRepository.update(job.id, {
                    status: "pending",
                    startedAt: null,
                    progress: 0,
                    progressMessage: null,
                });
                log.warn(
                    { jobId: job.id, syncStatus: error.syncStatus },
                    "Job deferred — OSV mirror sync in progress, will retry",
                );
                return;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            const errorCode = error instanceof JobFailure ? error.code : "PROCESSING_ERROR";
            await jobRepository.fail(job.id, errorCode, errorMessage);
            log.error({ jobId: job.id, error: errorMessage }, "Job processing failed");

            if (SCAN_JOB_TYPES.has(job.type)) {
                await recordScanRun(job, { status: "failed", errorMessage });
            }
        }
    },

    /**
     * Atomically claim and process pending jobs.
     * Uses row-level locking (FOR UPDATE SKIP LOCKED) so multiple
     * worker instances can run concurrently without duplicate processing.
     */
    async processReadyJobs(limit = 5): Promise<number> {
        // One claim per job, not one claim for the batch. A claimed job is
        // `processing` with `started_at` set from the moment it is claimed,
        // so claiming ten and running them in sequence marked nine rows as
        // running that nothing had started. When the worker died mid-batch
        // (2026-09-10, OOM-killed by syft) those rows were too young for the
        // startup stale sweep and stayed `processing` for good. Claiming as
        // each job begins means a crash strands at most the one it was
        // actually running — and the row's timestamps mean what they say.
        let processed = 0;
        while (processed < limit) {
            const [job] = await jobRepository.claimNextJobs(1);
            if (!job) break;
            await this.executeJob(job);
            processed += 1;
        }
        return processed;
    },

    /**
     * Clean up old completed jobs
     */
    async cleanup(daysOld = 30): Promise<number> {
        const count = await jobRepository.cleanupOld(daysOld);
        log.info({ deletedCount: count, daysOld }, "Cleaned up old jobs");
        return count;
    },
};
