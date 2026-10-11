/**
 * Data access for the fixes surface: the rollup's raw counts, the spread of
 * images over workloads and releases, and the delivery context the
 * suggestion feed reads.
 *
 * The rollup query goes through `collapsedFindings` — the single definition
 * of a finding — and adds no counting rules of its own. There is no
 * suppression join any more: the `finding_states` table stays only for its
 * deprecation window, and a surface that excluded rows nothing can write
 * would be dead code wearing a feature's name.
 *
 * `appendEvent` and the plan-window sweep for `activity_events` live here
 * because the scan job and the retention sweep already import this module;
 * the feed's reader is `activity-feed.repository.ts`.
 */

import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { collapsedFindings, deployedImages } from "../db/findings.js";
import { PLAN_LIMITS, getPlanLimits, type PlanType } from "../config/plans.js";
import type { ActivityEvent, NewActivityEvent } from "../db/schema/remediation.js";

/** One aggregated cell of the phase-1 rollup, folded by the service. */
export interface RollupCell {
    imageId: string;
    fixable: boolean;
    /**
     * The finding is on a package the customer's build added (the tier lens's
     * `application` bucket, `db/finding-tier.ts`). `fixable && byYou` is
     * "fixable by you": a fixed glibc is fixable, and not by a dependency bump.
     */
    byYou: boolean;
    matchedEcosystem: string | null;
    severityLevel: string | null;
    count: number;
    /**
     * Summed per-finding risk of the cell — the suggestion feed's "could
     * address up to" upper bound for unmeasured moves. Since ADR 0007 this is
     * the same arithmetic as the aggregate score itself, so "up to" is now an
     * exact ceiling rather than a deliberate overstatement.
     */
    riskSum: number;
}

export const remediationRepository = {
    /**
     * The rollup's raw material: per image, findings counted into
     * (fixable, by-you, ecosystem, severity) cells. The service applies the
     * EOL verdict — a TypeScript judgement over vendored dates — which is why
     * the ecosystem string comes out instead of a bucket name.
     */
    async fixRollup(orgId: string): Promise<RollupCell[]> {
        const f = collapsedFindings(deployedImages(orgId));
        const fixable = sql<boolean>`${f.fixedVersion} IS NOT NULL`;
        const byYou = sql<boolean>`${f.bucket} = 'application'`;

        const rows = await db
            .select({
                imageId: f.imageId,
                fixable: sql<boolean>`${fixable}`.as("fixable"),
                byYou: sql<boolean>`${byYou}`.as("by_you"),
                matchedEcosystem: f.matchedEcosystem,
                severityLevel: f.severityLevel,
                count: sql<number>`count(*)::int`,
                riskSum: sql<number>`coalesce(sum(${f.riskScore}), 0)::float`,
            })
            .from(f)
            .groupBy(f.imageId, fixable, byYou, f.matchedEcosystem, f.severityLevel);

        return rows;
    },

    /**
     * Distinct workloads and distinct images per Helm release — the spread an
     * unmeasured chart bump lands on. Counted here rather than summed from
     * per-image rows so a workload running two of the release's images is
     * one workload.
     */
    async releaseSpread(
        orgId: string,
    ): Promise<Map<string, { workloads: number; containers: number; images: number }>> {
        const rows = await db
            .select({
                releaseId: schema.workloads.releaseId,
                workloads: sql<number>`count(DISTINCT ${schema.workloads.id})::int`,
                containers: sql<number>`count(DISTINCT ${schema.workloadContainers.id})::int`,
                images: sql<number>`count(DISTINCT ${schema.workloadContainers.imageId})::int`,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .where(and(eq(schema.workloadContainers.orgId, orgId), isNotNull(schema.workloads.releaseId)))
            .groupBy(schema.workloads.releaseId);
        return new Map(
            rows
                .filter((r): r is typeof r & { releaseId: string } => r.releaseId != null)
                .map((r) => [r.releaseId, { workloads: r.workloads, containers: r.containers, images: r.images }]),
        );
    },

    /** Distinct workloads per image across the org — the "6 moves, not 40 rows" number. */
    async workloadCountsByImage(orgId: string): Promise<Map<string, number>> {
        const rows = await db
            .select({
                imageId: schema.workloadContainers.imageId,
                workloads: sql<number>`count(DISTINCT ${schema.workloadContainers.workloadId})::int`,
            })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.orgId, orgId))
            .groupBy(schema.workloadContainers.imageId);
        return new Map(rows.map((r) => [r.imageId, r.workloads]));
    },

    /**
     * The releases whose workloads run any of `imageIds`, one row per
     * (release, image) pair — the suggestion feed's release-axis fan-out set.
     * The caller folds rows into release → images; the images are how the
     * feed knows which release a finding-carrying image is packaged by.
     */
    async releasesForImages(orgId: string, imageIds: string[]) {
        if (imageIds.length === 0) return [];
        return db
            .selectDistinct({
                releaseId: schema.helmReleases.id,
                name: schema.helmReleases.name,
                namespace: schema.helmReleases.namespace,
                chartName: schema.helmReleases.chartName,
                chartVersion: schema.helmReleases.chartVersion,
                appVersion: schema.helmReleases.appVersion,
                repoUrl: schema.helmReleases.repoUrl,
                clusterId: schema.helmReleases.clusterId,
                clusterName: schema.clusters.name,
                imageId: schema.workloadContainers.imageId,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .innerJoin(schema.clusters, eq(schema.helmReleases.clusterId, schema.clusters.id))
            .where(
                and(eq(schema.workloadContainers.orgId, orgId), inArray(schema.workloadContainers.imageId, imageIds)),
            );
    },

    /**
     * How each image is delivered — through a Helm release, a GitOps app,
     * both or neither. One row per distinct (image, release, application)
     * combination; the service folds. This is what decides whether a measured
     * tag move renders as a plain tag upgrade or as a values override on the
     * chart that pins the tag.
     */
    async deliveryContextForImages(orgId: string, imageIds: string[]) {
        if (imageIds.length === 0) return [];
        return db
            .selectDistinct({
                imageId: schema.workloadContainers.imageId,
                releaseId: schema.helmReleases.id,
                releaseName: schema.helmReleases.name,
                releaseNamespace: schema.helmReleases.namespace,
                releaseChartName: schema.helmReleases.chartName,
                applicationTool: schema.gitopsApplications.tool,
                applicationName: schema.gitopsApplications.name,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .leftJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .leftJoin(schema.gitopsApplications, eq(schema.workloads.applicationId, schema.gitopsApplications.id))
            .where(
                and(eq(schema.workloadContainers.orgId, orgId), inArray(schema.workloadContainers.imageId, imageIds)),
            );
    },

    // ----- activity_events -------------------------------------------------

    async appendEvent(data: NewActivityEvent, tx?: Transaction): Promise<ActivityEvent> {
        const [result] = await (tx ?? db).insert(schema.activityEvents).values(data).returning();
        return result!;
    },

    /**
     * The history-retention sweep for the activity feed: delete each org's
     * events older than its plan's `historyDays` window. The feed is a
     * history surface like trend snapshots and scan runs, and history windows
     * are real retention — so it is bounded by the same plan clock. Same
     * shape and same fail-safe as `metricsRepository.deleteBeyondPlanWindows`:
     * an unrecognised plan value deletes nothing.
     */
    async deleteEventsBeyondPlanWindows(): Promise<number> {
        let deleted = 0;
        for (const plan of Object.keys(PLAN_LIMITS) as PlanType[]) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - getPlanLimits(plan).historyDays);
            const orgsOnPlan = db
                .select({ id: schema.organizations.id })
                .from(schema.organizations)
                .where(eq(schema.organizations.plan, plan));
            const result = await db
                .delete(schema.activityEvents)
                .where(
                    and(lt(schema.activityEvents.createdAt, cutoff), inArray(schema.activityEvents.orgId, orgsOnPlan)),
                )
                .returning({ id: schema.activityEvents.id });
            deleted += result.length;
        }
        return deleted;
    },
};
