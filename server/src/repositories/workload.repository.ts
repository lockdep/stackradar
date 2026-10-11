import { eq, and, inArray, count, countDistinct, isNotNull, sql, asc, type SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { WorkloadContainer } from "../db/schema/workload-containers.js";
import { collapsedFindings, emptySeverityCounts, severityCountsByImage, type SeverityCounts } from "../db/findings.js";
import { imageRiskScores, emptyRiskRollup, type RiskRollup } from "../db/risk.js";
import { latestScanCompletionByImage } from "./image.repository.js";

/**
 * One running container, with everything the workloads list renders.
 *
 * The unit is the **container**, not the workload: findings hang off the image
 * a container references, and a workload with two containers on two images has
 * two different answers to "what is wrong with it". A mid-rollout Deployment
 * produces two rows for one container name, on two digests — that is the point
 * of `(workloadId, name, imageId)` identity, not an artefact of it.
 */
export interface WorkloadContainerWithStats {
    id: string;
    name: string;
    init: boolean;
    imageTag: string | null;
    imageRef: string;
    runningPods: number | null;
    firstSeenAt: Date;
    lastSeenAt: Date;

    workloadId: string;
    workloadName: string;
    /** `null` when the scanner could not resolve `ownerReferences` — never guessed. */
    workloadKind: string | null;
    /**
     * Pod labels merged over the controller's, from the allowlist the agent
     * collects. `null` = none survived the allowlist, not "not collected".
     *
     * Carried on the row so the client can sub-group unattributed workloads by
     * `app.kubernetes.io/part-of` without a second request and without any new
     * storage — the merge in the scanner is what puts `part-of` here for a
     * workload whose pod template never carried it.
     */
    workloadLabels: Record<string, string> | null;

    namespaceId: string;
    namespaceName: string;
    clusterId: string;

    releaseId: string | null;
    releaseName: string | null;
    chartName: string | null;
    chartVersion: string | null;

    /**
     * The delivery layer, independent of the release above. A workload
     * commonly has both — the chart is what a CVE report cites, the app is
     * where the fix is made — so neither is derivable from the other.
     */
    applicationId: string | null;
    applicationName: string | null;

    imageId: string;
    imageDigest: string;
    registry: string | null;
    repository: string | null;

    /** Null when no SBOM has landed for the image yet. */
    sbomId: string | null;
    /** When the SBOM was generated. Fixed for the life of the digest. */
    scannedAt: string | null;
    /**
     * When the SBOM was last matched against the OSV mirror — the findings'
     * freshness, which moves with every mirror-changing sync while
     * `scannedAt` stands still. `null` until a scan run completes.
     */
    lastMatchedAt: string | null;
    componentCount: number;
    /** `null` = nobody has scanned this image. Zeroes = scanned and clean. */
    vulnerabilities: SeverityCounts | null;
    /**
     * Distinct components on this image that a finding says how to fix —
     * "3 packages to bump", not "12 fixable findings".
     *
     * Components rather than findings because the component is the unit of
     * work: one `openssl` bump closes every advisory sitting on it, and a
     * number that counts the advisories describes effort that does not exist.
     *
     * `null` under exactly the same condition as `vulnerabilities` — nobody has
     * looked. Zero means we looked and nothing on this image states a fix,
     * which is the one thing a "has a fix available" filter must not confuse
     * with "we do not know yet".
     */
    fixableComponents: number | null;
    /**
     * The container's image's total risk — the unbounded sum of its findings'
     * scores (ADR 0007) — with the working shown.
     *
     * The image's rollup, not the workload's, because the list row *is* a
     * container and a container runs one image. Two containers of one workload
     * on two images legitimately carry two different numbers — that difference
     * is which of them to fix first, and averaging it away is what a
     * workload-level column here would do. The workload's own score, folded
     * across its containers, is `workloadRiskScores` in `db/risk.ts`.
     *
     * `null` under exactly the same condition as `vulnerabilities` and
     * `fixableComponents`: nobody has scanned this image. A zero means we
     * looked and found nothing, and sorting an unscanned image alongside a
     * clean one is the confusion those two fields already exist to avoid.
     */
    risk: RiskRollup | null;

    /**
     * Since when this slot has run *this digest* — the start of its open
     * `workload_container_history` interval. The list's "Running this image for":
     * one indexed probe per row and no walk across earlier digests, which is
     * the container page's job (`exposure.service.ts`). `null` = no interval
     * recorded yet, never zero.
     */
    onImageSince: Date | null;
    /** The interval began with the cluster's first report: it was already running when we first looked. */
    onImageSinceIsLowerBound: boolean;
}

/**
 * The open history interval of the row's (slot, digest) — the columns of
 * `wc_history_open_slot_unique`, so each probe is one index lookup.
 */
const openInterval = (select: SQL) => sql`(
    SELECT ${select}
    FROM workload_container_history h
    LEFT JOIN clusters c ON c.id = h.cluster_id
    WHERE h.cluster_id = ${schema.namespaces.clusterId}
      AND h.namespace = ${schema.namespaces.name}
      AND h.workload_name = ${schema.workloads.name}
      AND h.container_name = ${schema.workloadContainers.name}
      AND h.digest = ${schema.images.digest}
      AND h.ended_at IS NULL
)`;

/** The columns every container listing selects, so one join shape serves all of them. */
const containerColumns = {
    id: schema.workloadContainers.id,
    name: schema.workloadContainers.name,
    init: schema.workloadContainers.init,
    imageTag: schema.workloadContainers.imageTag,
    imageRef: schema.workloadContainers.imageRef,
    runningPods: schema.workloadContainers.runningPods,
    firstSeenAt: schema.workloadContainers.firstSeenAt,
    lastSeenAt: schema.workloadContainers.lastSeenAt,

    workloadId: schema.workloads.id,
    workloadName: schema.workloads.name,
    workloadKind: schema.workloads.kind,
    workloadLabels: schema.workloads.labels,

    namespaceId: schema.namespaces.id,
    namespaceName: schema.namespaces.name,
    clusterId: schema.namespaces.clusterId,

    releaseId: schema.workloads.releaseId,
    releaseName: schema.helmReleases.name,
    chartName: schema.helmReleases.chartName,
    chartVersion: schema.helmReleases.chartVersion,

    applicationId: schema.workloads.applicationId,
    applicationName: schema.gitopsApplications.name,

    imageId: schema.images.id,
    imageDigest: schema.images.digest,
    registry: schema.images.registry,
    repository: schema.images.repository,
    // Who controls the image (`lib/image-control.ts`) and which signal said so.
    control: schema.images.control,
    controlDetectedBy: schema.images.controlDetectedBy,
    controlDetail: schema.images.controlDetail,

    onImageSince: sql<Date | null>`${openInterval(sql`h.started_at`)}`.mapWith(
        schema.workloadContainerHistory.startedAt,
    ),
    // Unknown first observation proves nothing, so it reads as a lower bound
    // too; the tolerance is `CONTIGUITY_TOLERANCE_MS` in `lib/exposure.ts`.
    onImageSinceIsLowerBound: sql<boolean>`coalesce(${openInterval(
        sql`(h.started_at <= c.first_inventory_at + interval '10 minutes') IS NOT FALSE`,
    )}, false)`,
} as const;

function baseQuery() {
    return (
        db
            .select(containerColumns)
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
            // Left, not inner: a workload no chart manages is the common case, and
            // an inner join here would silently hide every unmanaged workload from
            // the list rather than showing it as unmanaged.
            .leftJoin(schema.helmReleases, eq(schema.workloads.releaseId, schema.helmReleases.id))
            // A second left join rather than a branch on the first: the two layers
            // are independent, and a workload with a chart but no app — or an app
            // but no chart — is ordinary rather than a case to handle.
            .leftJoin(schema.gitopsApplications, eq(schema.workloads.applicationId, schema.gitopsApplications.id))
    );
}

/**
 * Attach the image-derived stats to a set of container rows.
 *
 * Deliberately keyed on `imageId` and looked up per row, so the five containers
 * running one image all report the same numbers. Computing them per container
 * would be five identical aggregates and, worse, five chances to disagree.
 */
async function withImageStats<T extends { imageId: string }>(
    rows: T[],
): Promise<
    Array<
        T &
            Pick<
                WorkloadContainerWithStats,
                | "sbomId"
                | "scannedAt"
                | "lastMatchedAt"
                | "componentCount"
                | "vulnerabilities"
                | "fixableComponents"
                | "risk"
            >
    >
> {
    if (rows.length === 0) return [];
    const imageIds = [...new Set(rows.map((r) => r.imageId))];

    const [sbomRows, componentCounts, vulnByImage, fixableRows, lastMatchedByImage, riskByImage] = await Promise.all([
        db
            .select({
                id: schema.sboms.id,
                imageId: schema.sboms.imageId,
                createdAt: schema.sboms.createdAt,
            })
            .from(schema.sboms)
            .where(inArray(schema.sboms.imageId, imageIds)),
        db
            .select({
                imageId: schema.sboms.imageId,
                componentCount: count(schema.components.id),
            })
            .from(schema.components)
            .innerJoin(
                schema.sboms,
                and(eq(schema.components.sbomId, schema.sboms.id), inArray(schema.sboms.imageId, imageIds)),
            )
            .groupBy(schema.sboms.imageId),
        severityCountsByImage(imageIds),
        // A second pass over the same collapsed set rather than another column
        // on the one above: that one groups by severity, and a component with a
        // critical and a high in it would be counted under both, so summing its
        // rows would report one package to bump as two.
        (async () => {
            const findings = collapsedFindings(inArray(schema.images.id, imageIds));
            return db
                .select({
                    imageId: findings.imageId,
                    fixableComponents: countDistinct(findings.componentId),
                })
                .from(findings)
                .where(isNotNull(findings.fixedVersion))
                .groupBy(findings.imageId);
        })(),
        // Doubles as the scan-run witness below: an image with a timestamp
        // here has a completed, non-failed run.
        latestScanCompletionByImage(imageIds),
        // One fold per image for the whole page, not one per row: five
        // containers on one digest share a score for the same reason they share
        // a severity count.
        imageRiskScores(imageIds),
    ]);

    const sbomByImage = new Map(sbomRows.map((s) => [s.imageId, s]));
    const componentsByImage = new Map(componentCounts.map((c) => [c.imageId, c.componentCount]));
    const fixableByImage = new Map(fixableRows.map((f) => [f.imageId, f.fixableComponents]));

    // Same two-witness rule as before the cutover: a recorded scan run, or a
    // match row that could only exist because a scan wrote it. Either is enough
    // to turn "unknown" into a number; neither means nobody has looked.
    const scanned = new Set([...lastMatchedByImage.keys(), ...vulnByImage.keys()]);

    return rows.map((row) => {
        const sbom = sbomByImage.get(row.imageId);
        return {
            ...row,
            sbomId: sbom?.id ?? null,
            scannedAt: sbom?.createdAt?.toISOString() ?? null,
            lastMatchedAt: lastMatchedByImage.get(row.imageId)?.toISOString() ?? null,
            componentCount: componentsByImage.get(row.imageId) ?? 0,
            vulnerabilities: scanned.has(row.imageId) ? (vulnByImage.get(row.imageId) ?? emptySeverityCounts()) : null,
            // Tied to the same witness as `vulnerabilities`, deliberately: an
            // image nobody has scanned has no fixable packages *and* no
            // unfixable ones, and reporting 0 there would put it in the same
            // bucket as an image we checked and found nothing to bump on.
            fixableComponents: scanned.has(row.imageId) ? (fixableByImage.get(row.imageId) ?? 0) : null,
            // `imageRiskScores` returns no row for an image with no findings,
            // which is the same set `vulnerabilities` reports as all-zero. The
            // substitution happens here rather than in the fold because only
            // this layer knows whether the absence means "clean" or "unknown".
            risk: scanned.has(row.imageId) ? (riskByImage.get(row.imageId) ?? emptyRiskRollup()) : null,
        };
    });
}

export interface WorkloadFilter {
    clusterId?: string | undefined;
    namespaceId?: string | undefined;
    releaseId?: string | undefined;
    applicationId?: string | undefined;
    imageId?: string | undefined;
}

/** The per-cluster coverage aggregate, as both coverage queries return it. */
export type ClusterCoverage = {
    clusterId: string;
    discovered: number;
    scanned: number;
    reportedAt: Date | null;
    /**
     * Distinct registry hosts the scanner could not authenticate to, over the
     * cluster's containers that still have no SBOM. Empty when nothing is
     * blocked on credentials. Lets the org Dashboard raise the failure without
     * fetching every cluster's coverage rows.
     */
    registryAuthFailedHosts: string[];
    /** Containers without an SBOM whose last scan failed on registry auth. */
    registryAuthFailedWorkloads: number;
};

/*
 * Registry-auth failures, aggregated alongside the coverage counts. The
 * `sboms.id IS NULL` guard matches `findUnscannedByCluster` exactly, so the
 * card's "auth failed" rows and this summary count the same containers — a
 * stale error on an image that has since uploaded an SBOM is not a failure.
 */
const registryAuthUnscanned = sql`${schema.images.lastScanErrorCode} = 'registry_auth' AND ${schema.sboms.id} IS NULL`;
const registryAuthColumns = {
    registryAuthFailedHosts: sql<
        string[] | null
    >`array_remove(array_agg(DISTINCT ${schema.images.lastScanErrorHost}) FILTER (WHERE ${registryAuthUnscanned}), NULL)`,
    registryAuthFailedWorkloads: sql<number>`cast(count(*) FILTER (WHERE ${registryAuthUnscanned}) as int)`,
};

export const workloadRepository = {
    /**
     * Every running container in `orgId`, with its image's findings.
     *
     * The backing query for `GET /api/containers`. `orgId` is mandatory — this
     * must never be able to return another tenant's containers.
     */
    async findAllWithStats(orgId: string, filter: WorkloadFilter = {}): Promise<WorkloadContainerWithStats[]> {
        const conditions = [eq(schema.workloadContainers.orgId, orgId)];
        if (filter.clusterId) conditions.push(eq(schema.namespaces.clusterId, filter.clusterId));
        if (filter.namespaceId) conditions.push(eq(schema.workloads.namespaceId, filter.namespaceId));
        if (filter.releaseId) conditions.push(eq(schema.workloads.releaseId, filter.releaseId));
        if (filter.applicationId) {
            conditions.push(eq(schema.workloads.applicationId, filter.applicationId));
        }
        if (filter.imageId) conditions.push(eq(schema.workloadContainers.imageId, filter.imageId));

        const rows = await baseQuery()
            .where(and(...conditions))
            .orderBy(asc(schema.namespaces.name), asc(schema.workloads.name), asc(schema.workloadContainers.name));

        return withImageStats(rows);
    },

    async findByIdWithStats(id: string): Promise<WorkloadContainerWithStats | undefined> {
        const rows = await baseQuery().where(eq(schema.workloadContainers.id, id));
        const [withStats] = await withImageStats(rows);
        return withStats;
    },

    /** The raw container row, for ownership checks that do not need the stats. */
    async findContainerById(id: string): Promise<WorkloadContainer | undefined> {
        const [row] = await db.select().from(schema.workloadContainers).where(eq(schema.workloadContainers.id, id));
        return row;
    },

    /**
     * Coverage for a cluster: containers running, and how many of them run an
     * image that has an SBOM.
     *
     * One `LEFT JOIN`, which is the whole reason the former
     * `discovered_workloads` table is gone. `scanned <= discovered` now holds by construction rather than by a
     * `type = 'project'` filter that had to be repeated at every call site, and
     * the two numbers come from one scan of one set of rows so they cannot
     * describe two different populations.
     */
    async coverageByCluster(clusterId: string): Promise<ClusterCoverage | null> {
        const [row] = await db
            .select({
                discovered: count(),
                scanned: sql<number>`cast(count(${schema.sboms.id}) as int)`,
                reportedAt: sql<Date | null>`max(${schema.workloadContainers.lastSeenAt})`,
                ...registryAuthColumns,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .leftJoin(schema.images, eq(schema.images.id, schema.workloadContainers.imageId))
            .leftJoin(schema.sboms, eq(schema.sboms.imageId, schema.workloadContainers.imageId))
            .where(eq(schema.namespaces.clusterId, clusterId));

        if (!row || row.discovered === 0) return null;
        return {
            clusterId,
            discovered: row.discovered,
            scanned: row.scanned,
            reportedAt: row.reportedAt ?? null,
            registryAuthFailedHosts: row.registryAuthFailedHosts ?? [],
            registryAuthFailedWorkloads: row.registryAuthFailedWorkloads,
        };
    },

    /** The per-cluster aggregate for a whole org, in one grouped query. */
    async coverageByOrg(orgId: string): Promise<ClusterCoverage[]> {
        const rows = await db
            .select({
                clusterId: schema.namespaces.clusterId,
                discovered: count(),
                scanned: sql<number>`cast(count(${schema.sboms.id}) as int)`,
                reportedAt: sql<Date | null>`max(${schema.workloadContainers.lastSeenAt})`,
                ...registryAuthColumns,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .leftJoin(schema.images, eq(schema.images.id, schema.workloadContainers.imageId))
            .leftJoin(schema.sboms, eq(schema.sboms.imageId, schema.workloadContainers.imageId))
            .where(eq(schema.workloadContainers.orgId, orgId))
            .groupBy(schema.namespaces.clusterId);

        return rows.map((r) => ({
            clusterId: r.clusterId,
            discovered: r.discovered,
            scanned: r.scanned,
            reportedAt: r.reportedAt ?? null,
            registryAuthFailedHosts: r.registryAuthFailedHosts ?? [],
            registryAuthFailedWorkloads: r.registryAuthFailedWorkloads,
        }));
    },

    /**
     * The coverage gap: containers whose image has no SBOM, oldest first so the
     * list reads worst-first.
     *
     * `firstSeenAt` rides along because it separates the two cases the UI must
     * not conflate — a container discovered a minute ago is mid-pull, one
     * discovered four days ago is stuck and worth a human looking at.
     */
    async findUnscannedByCluster(clusterId: string) {
        return db
            .select({
                namespace: schema.namespaces.name,
                workloadName: schema.workloads.name,
                workloadKind: schema.workloads.kind,
                containerName: schema.workloadContainers.name,
                imageRef: schema.workloadContainers.imageRef,
                imageDigest: schema.images.digest,
                firstSeenAt: schema.workloadContainers.firstSeenAt,
                lastSeenAt: schema.workloadContainers.lastSeenAt,
                /*
                 * Why the image has no SBOM, when the scanner said. All null
                 * for a scan that is simply still in flight; the coverage
                 * card renders the reason and its remediation instead of
                 * guessing from elapsed time alone.
                 */
                scanErrorCode: schema.images.lastScanErrorCode,
                scanErrorHost: schema.images.lastScanErrorHost,
                scanErrorAt: schema.images.lastScanErrorAt,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
            .leftJoin(schema.sboms, eq(schema.sboms.imageId, schema.workloadContainers.imageId))
            .where(and(eq(schema.namespaces.clusterId, clusterId), sql`${schema.sboms.id} IS NULL`))
            .orderBy(
                asc(schema.workloadContainers.firstSeenAt),
                asc(schema.namespaces.name),
                asc(schema.workloads.name),
            );
    },

    /** Count of running containers — the "workloads" number on the dashboards. */
    async countByOrg(orgId: string): Promise<number> {
        const [row] = await db
            .select({ count: count() })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.orgId, orgId));
        return row?.count ?? 0;
    },

    // --- writes, used by the inventory path and by SBOM upload ---
};
