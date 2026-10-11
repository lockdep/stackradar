import { eq, and, gte, lt, count, desc, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { isTenantOrg, isTenantCluster } from "../db/tenant-orgs.js";
import { PLAN_LIMITS, getPlanLimits, type PlanType } from "../config/plans.js";
import {
    orgMetricsSnapshots,
    type OrgMetricsSnapshot,
    type NewOrgMetricsSnapshot,
    clusterMetricsSnapshots,
    type ClusterMetricsSnapshot,
    type NewClusterMetricsSnapshot,
    organizations,
    clusters,
    images,
    namespaces,
    sboms,
    components,
    workloadContainers,
    workloads,
} from "../db/schema/index.js";
import { collapsedFindings, deployedImages, deployedImagesInCluster } from "../db/findings.js";
import { clusterRiskScores, orgRiskRollup } from "../db/risk.js";
import { lensBucket, type LensBucket } from "../db/finding-tier.js";
import { emptySnapshotBreakdown, sideOfControl, type SnapshotBreakdown } from "../lib/snapshot-breakdown.js";

/**
 * The counted fields of a snapshot, without its identity or timestamp — what
 * `computeCurrent*Metrics` returns and what a refresh writes back over a row
 * that is still settling.
 */
export type SnapshotMetrics = {
    totalVulnerabilities: number;
    totalWorkloads: number;
    totalComponents: number;
    criticalVulnerabilities: number;
    highVulnerabilities: number;
    mediumVulnerabilities: number;
    lowVulnerabilities: number;
    /**
     * The scope's total risk at capture (ADR 0007), so both the cluster
     * Overview's and the Dashboard's risk-score cards can draw a trend line.
     */
    riskScore: number;
    /** The counts above, per whose-image side and lens bucket — see `lib/snapshot-breakdown.ts`. */
    breakdown: SnapshotBreakdown;
};

/**
 * Findings and components of the images in `scope`, per side and lens bucket.
 *
 * The findings half *is* the snapshot's severity count — the totals are summed
 * from these cells rather than counted a second time — so the breakdown costs
 * the capture one grouped components count and no extra pass over findings,
 * and a filtered trend's "All" can never disagree with the unfiltered one.
 */
async function computeBreakdown(scope: SQL): Promise<SnapshotBreakdown> {
    const breakdown = emptySnapshotBreakdown();

    // One definition of a finding for every surface — see src/db/findings.ts.
    // These snapshots feed the trend charts that sit directly above the
    // severity cards on the same page, so counting differently here is
    // counting differently in two panels a centimetre apart.
    const findings = collapsedFindings(scope);
    const findingRows = await db
        .select({
            control: images.control,
            bucket: sql<LensBucket>`${findings.bucket}`,
            severityLevel: findings.severityLevel,
            count: count(),
            risk: sql<number>`coalesce(sum(${findings.riskScore}), 0)::float8`,
        })
        .from(findings)
        .innerJoin(images, eq(images.id, findings.imageId))
        .groupBy(images.control, findings.bucket, findings.severityLevel);

    const risk = new Map<string, number>();
    for (const row of findingRows) {
        const side = sideOfControl(row.control);
        const cell = breakdown.findings[side][row.bucket];
        cell.total += row.count;
        const severity = (row.severityLevel ?? "").toLowerCase();
        if (severity === "critical" || severity === "high" || severity === "medium" || severity === "low") {
            cell[severity] += row.count;
        }
        const key = `${side}|${row.bucket}`;
        risk.set(key, (risk.get(key) ?? 0) + Number(row.risk));
    }
    // Rounded once per cell, after the severities are summed — as the column rounds the whole.
    for (const [key, value] of risk) {
        const [side, bucket] = key.split("|") as [keyof SnapshotBreakdown["findings"], LensBucket];
        breakdown.findings[side][bucket].risk = Math.round(value);
    }

    /* Components are counted per *image*, deduplicated: an image running in
       five namespaces contributes its components once. */
    const componentRows = await db
        .select({ control: images.control, bucket: sql<LensBucket>`${lensBucket}`, count: count() })
        .from(components)
        .innerJoin(sboms, eq(components.sbomId, sboms.id))
        .innerJoin(images, and(eq(sboms.imageId, images.id), scope))
        .groupBy(images.control, lensBucket);
    for (const row of componentRows) {
        breakdown.components[sideOfControl(row.control)][row.bucket] += row.count;
    }

    return breakdown;
}

/** The flat severity and total columns, summed from the breakdown's cells. */
function findingTotals(breakdown: SnapshotBreakdown) {
    const totals = {
        totalVulnerabilities: 0,
        criticalVulnerabilities: 0,
        highVulnerabilities: 0,
        mediumVulnerabilities: 0,
        lowVulnerabilities: 0,
    };
    let totalComponents = 0;
    for (const side of Object.values(breakdown.findings)) {
        for (const cell of Object.values(side)) {
            totals.totalVulnerabilities += cell.total;
            totals.criticalVulnerabilities += cell.critical;
            totals.highVulnerabilities += cell.high;
            totals.mediumVulnerabilities += cell.medium;
            totals.lowVulnerabilities += cell.low;
        }
    }
    for (const side of Object.values(breakdown.components)) {
        for (const n of Object.values(side)) totalComponents += n;
    }
    return { ...totals, totalComponents };
}

export const metricsRepository = {
    // --- Org snapshots ---

    async insert(data: NewOrgMetricsSnapshot): Promise<OrgMetricsSnapshot> {
        const [result] = await db.insert(orgMetricsSnapshots).values(data).returning();
        return result!;
    },

    async findByOrg(orgId: string, days: number): Promise<OrgMetricsSnapshot[]> {
        const since = new Date();
        since.setDate(since.getDate() - days);
        return db
            .select()
            .from(orgMetricsSnapshots)
            .where(and(eq(orgMetricsSnapshots.orgId, orgId), gte(orgMetricsSnapshots.capturedAt, since)))
            .orderBy(orgMetricsSnapshots.capturedAt);
    },

    /**
     * The history-retention sweep: delete each org's snapshots older than its
     * *plan's* window (`historyDays` in `config/plans.ts`) — trend depth is a
     * paid axis, so the sweep cannot use one global cutoff.
     *
     * One delete per known plan rather than a CASE join, so the statement
     * stays a plain indexed range delete. An org whose `plan` value matches
     * no known plan is skipped entirely — deleting history fails unsafe (a
     * mislabeled paying org loses a year of trends), keeping it fails safe
     * (a few extra rows until the value is fixed).
     */
    async deleteBeyondPlanWindows(): Promise<number> {
        let deleted = 0;
        for (const plan of Object.keys(PLAN_LIMITS) as PlanType[]) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - getPlanLimits(plan).historyDays);
            const orgsOnPlan = db
                .select({ id: organizations.id })
                .from(organizations)
                .where(eq(organizations.plan, plan));
            const result = await db
                .delete(orgMetricsSnapshots)
                .where(and(lt(orgMetricsSnapshots.capturedAt, cutoff), inArray(orgMetricsSnapshots.orgId, orgsOnPlan)))
                .returning({ id: orgMetricsSnapshots.id });
            deleted += result.length;
        }
        return deleted;
    },

    async computeCurrentMetrics(orgId: string): Promise<SnapshotMetrics> {
        /* Running containers, not scanned ones. The `type = 'project'` filter
           this replaces existed to keep pending rows out of the count; with
           "running" and "scanned" in separate tables the filter has nothing
           left to do. */
        const containerRows = await db
            .select({ control: images.control, count: count() })
            .from(workloadContainers)
            .innerJoin(images, eq(images.id, workloadContainers.imageId))
            .where(eq(workloadContainers.orgId, orgId))
            .groupBy(images.control);

        const breakdown = await computeBreakdown(deployedImages(orgId));
        for (const row of containerRows) breakdown.containers[sideOfControl(row.control)] += row.count;

        /* The same fold the Dashboard's "Total risk" panel reports, so the
           trend's last point and the live number can never disagree. Rounded
           at capture because the column stores what the card shows. */
        const risk = await orgRiskRollup(orgId);

        return {
            totalWorkloads: breakdown.containers.yours + breakdown.containers["third-party"],
            ...findingTotals(breakdown),
            riskScore: Math.round(risk.score),
            breakdown,
        };
    },

    /** The org's most recent snapshot — the point the trend chart draws last. */
    /** The newest snapshot captured at or before `before` — the digest's "a week ago". */
    async findOrgSnapshotBefore(orgId: string, before: Date): Promise<OrgMetricsSnapshot | undefined> {
        const [row] = await db
            .select()
            .from(orgMetricsSnapshots)
            .where(and(eq(orgMetricsSnapshots.orgId, orgId), lte(orgMetricsSnapshots.capturedAt, before)))
            .orderBy(desc(orgMetricsSnapshots.capturedAt))
            .limit(1);
        return row;
    },

    async findLatestOrgSnapshot(orgId: string): Promise<OrgMetricsSnapshot | undefined> {
        const [row] = await db
            .select()
            .from(orgMetricsSnapshots)
            .where(eq(orgMetricsSnapshots.orgId, orgId))
            .orderBy(desc(orgMetricsSnapshots.capturedAt))
            .limit(1);
        return row;
    },

    /**
     * Rewrite a snapshot's counts in place and restamp it to now.
     *
     * Used only to settle a point that is still describing a scan wave in
     * progress — see `metricsService.refreshSettlingSnapshots`. Restamping is
     * the honest part: the row now means "as of this moment", and since only
     * the newest row is ever refreshed, moving its timestamp forward cannot
     * reorder the series.
     */
    async updateOrgSnapshot(id: string, metrics: SnapshotMetrics): Promise<void> {
        await db
            .update(orgMetricsSnapshots)
            .set({ ...metrics, capturedAt: new Date() })
            .where(eq(orgMetricsSnapshots.id, id));
    },

    async findAllOrgIds(): Promise<string[]> {
        // Tenants only (`db/tenancy.ts`): the platform org has no dashboard,
        // so snapshotting it is pure waste, and the demo org's findings are
        // a staged exhibit, not customer risk.
        const rows = await db.select({ id: organizations.id }).from(organizations).where(isTenantOrg());
        return rows.map((r) => r.id);
    },

    // --- Cluster snapshots ---

    async insertCluster(data: NewClusterMetricsSnapshot): Promise<ClusterMetricsSnapshot> {
        const [result] = await db.insert(clusterMetricsSnapshots).values(data).returning();
        return result!;
    },

    async findByCluster(clusterId: string, days: number): Promise<ClusterMetricsSnapshot[]> {
        const since = new Date();
        since.setDate(since.getDate() - days);
        return db
            .select()
            .from(clusterMetricsSnapshots)
            .where(
                and(eq(clusterMetricsSnapshots.clusterId, clusterId), gte(clusterMetricsSnapshots.capturedAt, since)),
            )
            .orderBy(clusterMetricsSnapshots.capturedAt);
    },

    /** Cluster-snapshot half of `deleteBeyondPlanWindows` — same rules. */
    async deleteClusterSnapshotsBeyondPlanWindows(): Promise<number> {
        let deleted = 0;
        for (const plan of Object.keys(PLAN_LIMITS) as PlanType[]) {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - getPlanLimits(plan).historyDays);
            const clustersOnPlan = db
                .select({ id: clusters.id })
                .from(clusters)
                .innerJoin(organizations, eq(clusters.orgId, organizations.id))
                .where(eq(organizations.plan, plan));
            const result = await db
                .delete(clusterMetricsSnapshots)
                .where(
                    and(
                        lt(clusterMetricsSnapshots.capturedAt, cutoff),
                        inArray(clusterMetricsSnapshots.clusterId, clustersOnPlan),
                    ),
                )
                .returning({ id: clusterMetricsSnapshots.id });
            deleted += result.length;
        }
        return deleted;
    },

    async computeCurrentClusterMetrics(clusterId: string): Promise<SnapshotMetrics> {
        const containerRows = await db
            .select({ control: images.control, count: count() })
            .from(workloadContainers)
            .innerJoin(workloads, eq(workloadContainers.workloadId, workloads.id))
            .innerJoin(namespaces, eq(workloads.namespaceId, namespaces.id))
            .innerJoin(images, eq(images.id, workloadContainers.imageId))
            .where(eq(namespaces.clusterId, clusterId))
            .groupBy(images.control);

        const breakdown = await computeBreakdown(deployedImagesInCluster(clusterId));
        for (const row of containerRows) breakdown.containers[sideOfControl(row.control)] += row.count;

        /* The same fold the cluster header and Clusters list report, so the
           trend's last point and the live number can never disagree. Rounded
           at capture because the column stores what the card shows. */
        const risk = (await clusterRiskScores([clusterId])).get(clusterId);

        return {
            totalWorkloads: breakdown.containers.yours + breakdown.containers["third-party"],
            ...findingTotals(breakdown),
            riskScore: Math.round(risk?.score ?? 0),
            breakdown,
        };
    },

    /** Per-cluster counterpart of `findLatestOrgSnapshot`. */
    async findLatestClusterSnapshot(clusterId: string): Promise<ClusterMetricsSnapshot | undefined> {
        const [row] = await db
            .select()
            .from(clusterMetricsSnapshots)
            .where(eq(clusterMetricsSnapshots.clusterId, clusterId))
            .orderBy(desc(clusterMetricsSnapshots.capturedAt))
            .limit(1);
        return row;
    },

    /** Per-cluster counterpart of `updateOrgSnapshot`. */
    async updateClusterSnapshot(id: string, metrics: SnapshotMetrics): Promise<void> {
        await db
            .update(clusterMetricsSnapshots)
            .set({ ...metrics, capturedAt: new Date() })
            .where(eq(clusterMetricsSnapshots.id, id));
    },

    async findAllClusterIds(): Promise<string[]> {
        // Same exclusion as findAllOrgIds, through the cluster's org for the
        // demo case (clusters carry no `demo` flag of their own).
        const rows = await db.select({ id: clusters.id }).from(clusters).where(isTenantCluster());
        return rows.map((r) => r.id);
    },
};
