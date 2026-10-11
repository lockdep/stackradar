import { metricsRepository } from "../repositories/metrics.repository.js";
import { vulnerabilityScanRunRepository } from "../repositories/vulnerability-scan-run.repository.js";
import { remediationRepository } from "../repositories/remediation.repository.js";
import { containerHistoryRepository } from "../repositories/container-history.repository.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("metrics-service");

/**
 * How recent the newest snapshot has to be for `refreshSnapshots` to rewrite it
 * instead of adding a point beside it.
 *
 * One metrics-cron period (`METRICS_CRON`, hourly by default). Inside that
 * window the newest row is the one the cron would overwrite anyway, so rewriting
 * it costs no history and keeps the series at one point per hour. Outside it,
 * the row is real history and gets a new point instead.
 */
const SNAPSHOT_PERIOD_MS = 60 * 60_000;

export const metricsService = {
    async captureSnapshot(orgId: string): Promise<void> {
        const metrics = await metricsRepository.computeCurrentMetrics(orgId);
        await metricsRepository.insert({ orgId, ...metrics });
        log.debug({ orgId, ...metrics }, "Org metrics snapshot captured");
    },

    async captureAllOrgs(): Promise<number> {
        const orgIds = await metricsRepository.findAllOrgIds();
        let captured = 0;
        for (const orgId of orgIds) {
            try {
                await metricsService.captureSnapshot(orgId);
                captured++;
            } catch (error) {
                log.error({ error, orgId }, "Failed to capture metrics snapshot for org");
            }
        }
        return captured;
    },

    async captureClusterSnapshot(clusterId: string): Promise<void> {
        const metrics = await metricsRepository.computeCurrentClusterMetrics(clusterId);
        await metricsRepository.insertCluster({ clusterId, ...metrics });
        log.debug({ clusterId, ...metrics }, "Cluster metrics snapshot captured");
    },

    async captureAllClusters(): Promise<number> {
        const clusterIds = await metricsRepository.findAllClusterIds();
        let captured = 0;
        for (const clusterId of clusterIds) {
            try {
                await metricsService.captureClusterSnapshot(clusterId);
                captured++;
            } catch (error) {
                log.error({ error, clusterId }, "Failed to capture metrics snapshot for cluster");
            }
        }
        return captured;
    },

    /**
     * Write the current numbers into the trend store after a scan, so the last
     * point on the chart agrees with the live severity cards above it.
     *
     * One rule: if the newest snapshot is from the current period, rewrite it;
     * otherwise add a point. That covers both things this needs to do.
     *
     * *Starts the line on day one.* A brand-new org has no snapshot, so the
     * first scan to finish adds one. Without it the chart is empty until the
     * next cron boundary — a mean of thirty minutes of a user's first session.
     *
     * *Keeps it honest while the install lands.* A first install scans dozens
     * of workloads over several minutes, and every one of them that finishes
     * rewrites the same row. Only ever writing the first would freeze whatever
     * fraction had been scanned when it happened to land: the severity cards
     * read live and said 58 criticals while the chart's only point, written
     * three minutes earlier, said 17. Rewriting means the point simply follows
     * the numbers up, and the last scan to finish leaves it correct — no
     * detecting when the wave is done, no separate settle pass.
     *
     * Rewriting in place is also what keeps this from inventing history: the
     * row it overwrites is the one the hourly cron would have overwritten
     * anyway, so the series keeps its one-point-per-hour shape.
     *
     * Called on every scan completion. That is one `computeCurrentMetrics` per
     * completed scan — an org-wide aggregate, but a small fraction of the scan
     * that just ran, and the queue runs them one at a time.
     *
     * Best-effort by contract: callers must not fail their own work over it.
     */
    async refreshSnapshots(orgId: string, clusterId: string): Promise<void> {
        const cutoff = Date.now() - SNAPSHOT_PERIOD_MS;
        const isCurrentPeriod = (capturedAt: Date | null): boolean =>
            capturedAt !== null && capturedAt.getTime() > cutoff;

        const [orgLatest, clusterLatest] = await Promise.all([
            metricsRepository.findLatestOrgSnapshot(orgId),
            metricsRepository.findLatestClusterSnapshot(clusterId),
        ]);

        const orgMetrics = await metricsRepository.computeCurrentMetrics(orgId);
        if (orgLatest && isCurrentPeriod(orgLatest.capturedAt)) {
            await metricsRepository.updateOrgSnapshot(orgLatest.id, orgMetrics);
        } else {
            await metricsRepository.insert({ orgId, ...orgMetrics });
        }

        const clusterMetrics = await metricsRepository.computeCurrentClusterMetrics(clusterId);
        if (clusterLatest && isCurrentPeriod(clusterLatest.capturedAt)) {
            await metricsRepository.updateClusterSnapshot(clusterLatest.id, clusterMetrics);
        } else {
            await metricsRepository.insertCluster({ clusterId, ...clusterMetrics });
        }

        log.debug({ orgId, clusterId, ...orgMetrics }, "Refreshed metrics snapshots after scan");
    },

    /**
     * The history-retention sweep: every table that *is* history — trend
     * snapshots, scan runs and the activity feed — loses rows older than each
     * org's plan window (`historyDays`, `config/plans.ts`). Retention used to
     * be one global 90 days; it is per-plan now because history depth is what
     * the paid tiers sell, and the privacy policy states the window as a real
     * deletion schedule rather than a read cutoff.
     */
    async cleanup(): Promise<number> {
        const [orgCleaned, clusterCleaned, runsCleaned, eventsCleaned, intervalsCleaned] = await Promise.all([
            metricsRepository.deleteBeyondPlanWindows(),
            metricsRepository.deleteClusterSnapshotsBeyondPlanWindows(),
            vulnerabilityScanRunRepository.deleteBeyondPlanWindows(),
            remediationRepository.deleteEventsBeyondPlanWindows(),
            // Closed container intervals age on `ended_at`; open ones are current and stay.
            containerHistoryRepository.deleteBeyondPlanWindows(),
        ]);
        return orgCleaned + clusterCleaned + runsCleaned + eventsCleaned + intervalsCleaned;
    },
};
