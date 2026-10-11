import { eq, and, sql, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { HelmRelease } from "../db/schema/helm-releases.js";
import { emptySeverityCounts, severityCountsForScope, type SeverityCounts } from "../db/findings.js";
import { releaseRiskScores, emptyRiskRollup, type RiskRollup } from "../db/risk.js";
import { inArray } from "drizzle-orm";

export interface HelmReleaseWithCounts extends HelmRelease {
    workloadCount: number;
    containerCount: number;
    /** Distinct images this release deploys — the unit a remediation acts on. */
    imageCount: number;
    /** How many namespaces its workloads landed in. > 1 is legal and worth showing. */
    namespaceCount: number;
    /**
     * `true` when another release in the org carries the same `chartName` but a
     * different (or unknown) `repoUrl`. Several repositories publish `nginx`,
     * so a fleet-wide "all releases of chart X" is a *name* match until
     * `repoUrl` is known — and the UI has to say so rather than imply the
     * releases are the same chart.
     */
    chartNameAmbiguous: boolean;
    /**
     * The release's aggregate risk, folded across every workload the chart
     * deploys — including the ones that landed in another namespace.
     *
     * Folded from raw findings rather than from its images' scores: the rank
     * decay is per group, so composing folds would give every image's worst
     * finding an undecayed slot. See `db/risk.ts`.
     */
    risk: RiskRollup;
}

export const helmReleaseRepository = {
    async findById(id: string): Promise<HelmRelease | undefined> {
        const [row] = await db.select().from(schema.helmReleases).where(eq(schema.helmReleases.id, id));
        return row;
    },

    /**
     * Releases in the org, each with what it deploys.
     *
     * Counted through `workloads.releaseId` rather than by matching namespaces,
     * because a chart may deploy into namespaces other than the release's own —
     * grouping by the workload's namespace silently splits one release into
     * several.
     */
    /**
     * `attributedRepoByChart` (chart name → attributed repo URL, from
     * `chartAttributionRepository`) lets the ambiguity check substitute the
     * inference for a null `repoUrl`: two null-repo releases of one chart
     * stop being a silent merge once the attribution names their repository.
     * Unresolved nulls still flag ambiguous.
     */
    async findAllWithCounts(
        orgId: string,
        clusterId?: string,
        attributedRepoByChart?: Map<string, string>,
    ): Promise<HelmReleaseWithCounts[]> {
        const conditions = [eq(schema.helmReleases.orgId, orgId)];
        if (clusterId) conditions.push(eq(schema.helmReleases.clusterId, clusterId));

        const rows = await db
            .select({
                release: schema.helmReleases,
                workloadCount: sql<number>`cast(count(DISTINCT ${schema.workloads.id}) as int)`,
                containerCount: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.id}) as int)`,
                imageCount: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.imageId}) as int)`,
                namespaceCount: sql<number>`cast(count(DISTINCT ${schema.workloads.namespaceId}) as int)`,
            })
            .from(schema.helmReleases)
            .leftJoin(schema.workloads, eq(schema.workloads.releaseId, schema.helmReleases.id))
            .leftJoin(schema.workloadContainers, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .where(and(...conditions))
            .groupBy(schema.helmReleases.id)
            .orderBy(asc(schema.helmReleases.name));

        /*
         * A chart name is ambiguous when more than one release claims it and we
         * cannot prove they came from the same repository. Two conditions, and
         * the second is the one that is easy to miss: two releases of `nginx`
         * from *different* known repos are obviously two charts, but two with
         * *unknown* repos are the silent merge — they look identical and there
         * is nothing in the data to separate them.
         *
         * A lone release of a chart is never ambiguous; there is nothing for it
         * to be merged with.
         */
        const byChart = new Map<string, { releases: number; repos: Set<string | null> }>();
        for (const r of rows) {
            const chart = r.release.chartName;
            if (!chart) continue;
            const entry = byChart.get(chart) ?? { releases: 0, repos: new Set<string | null>() };
            entry.releases += 1;
            entry.repos.add(r.release.repoUrl ?? attributedRepoByChart?.get(chart) ?? null);
            byChart.set(chart, entry);
        }

        const ambiguous = (chart: string | null): boolean => {
            if (!chart) return false;
            const entry = byChart.get(chart);
            if (!entry || entry.releases < 2) return false;
            return entry.repos.size > 1 || entry.repos.has(null);
        };

        const risk = await releaseRiskScores(rows.map((r) => r.release.id));

        return rows.map((r) => ({
            ...r.release,
            risk: risk.get(r.release.id) ?? emptyRiskRollup(),
            workloadCount: r.workloadCount,
            containerCount: r.containerCount,
            imageCount: r.imageCount,
            namespaceCount: r.namespaceCount,
            chartNameAmbiguous: ambiguous(r.release.chartName),
        }));
    },

    /** Aggregate findings across every image the release deploys. */
    async findingsForRelease(releaseId: string): Promise<SeverityCounts> {
        const imageRows = await db
            .selectDistinct({ imageId: schema.workloadContainers.imageId })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .where(eq(schema.workloads.releaseId, releaseId));

        if (imageRows.length === 0) return emptySeverityCounts();

        return severityCountsForScope(
            inArray(
                schema.images.id,
                imageRows.map((r) => r.imageId),
            ),
        );
    },

    /**
     * The distinct images a release deploys.
     *
     * The release page's remediation list: "this chart runs these six images",
     * which is what a `helm upgrade` has to move, as opposed to the workload
     * list which is where the change lands.
     */
    async findImagesForRelease(releaseId: string) {
        return db
            .selectDistinct({
                imageId: schema.images.id,
                digest: schema.images.digest,
                registry: schema.images.registry,
                repository: schema.images.repository,
                imageTag: schema.workloadContainers.imageTag,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
            .where(eq(schema.workloads.releaseId, releaseId))
            .orderBy(asc(schema.images.repository));
    },

    /**
     * Workloads no release manages — the "unmanaged" group.
     *
     * Its own query rather than a `null` bucket the caller has to remember to
     * ask for: a release-grouped view that quietly omits every unmanaged
     * workload is a view that under-reports the fleet, and the omission is
     * invisible precisely because those rows have no group to be missing from.
     */
    async countUnmanaged(orgId: string, clusterId?: string): Promise<{ workloads: number; containers: number }> {
        const conditions = [eq(schema.workloadContainers.orgId, orgId), sql`${schema.workloads.releaseId} IS NULL`];
        if (clusterId) conditions.push(eq(schema.namespaces.clusterId, clusterId));

        const [row] = await db
            .select({
                workloads: sql<number>`cast(count(DISTINCT ${schema.workloads.id}) as int)`,
                containers: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.id}) as int)`,
            })
            .from(schema.workloadContainers)
            .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
            .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .where(and(...conditions));

        return { workloads: row?.workloads ?? 0, containers: row?.containers ?? 0 };
    },
};
