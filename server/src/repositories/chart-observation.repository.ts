/**
 * Reads and writes for the provenance-free chart observation tables —
 * [measuring-candidate-charts.md](../../../docs/proposals/measuring-candidate-charts.md).
 *
 * Nothing here takes an `orgId`, because the tables carry none. Tenant code
 * reaches these rows only through the candidate path in
 * `recommendForRelease`, which supplies the `(repoUrl, chartName)` identity
 * from the tenant's own release; there is no "list everything" surface.
 */

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type {
    ChartImageObservation,
    ChartRender,
    NewChartImageObservation,
    NewChartRender,
} from "../db/schema/chart-observations.js";

export const chartObservationRepository = {
    /** Upsert on the chart-version identity — a re-run overwrites its outcome. */
    async recordRender(data: NewChartRender): Promise<void> {
        await db
            .insert(schema.chartRenders)
            .values(data)
            .onConflictDoUpdate({
                target: [
                    schema.chartRenders.repoUrl,
                    schema.chartRenders.chartName,
                    schema.chartRenders.chartVersion,
                ],
                set: {
                    status: sql`excluded.status`,
                    failureReason: sql`excluded.failure_reason`,
                    helmVersion: sql`excluded.helm_version`,
                    kubeVersion: sql`excluded.kube_version`,
                    renderedAt: sql`excluded.rendered_at`,
                    updatedAt: new Date(),
                },
            });
    },

    /** Every version of a chart that has a render row, with its outcome. */
    async rendersForChart(
        repoUrl: string,
        chartName: string
    ): Promise<Array<{ chartVersion: string; status: ChartRender["status"] }>> {
        return db
            .select({
                chartVersion: schema.chartRenders.chartVersion,
                status: schema.chartRenders.status,
            })
            .from(schema.chartRenders)
            .where(
                and(
                    eq(schema.chartRenders.repoUrl, repoUrl),
                    eq(schema.chartRenders.chartName, chartName)
                )
            );
    },

    async upsertObservation(data: NewChartImageObservation): Promise<void> {
        await db
            .insert(schema.chartImageObservations)
            .values(data)
            .onConflictDoUpdate({
                target: [
                    schema.chartImageObservations.repoUrl,
                    schema.chartImageObservations.chartName,
                    schema.chartImageObservations.chartVersion,
                    schema.chartImageObservations.imageRef,
                ],
                set: {
                    registry: sql`excluded.registry`,
                    repository: sql`excluded.repository`,
                    tag: sql`excluded.tag`,
                    digest: sql`excluded.digest`,
                    resolutionError: sql`excluded.resolution_error`,
                    updatedAt: new Date(),
                },
            });
    },

    async observationsForVersion(
        repoUrl: string,
        chartName: string,
        chartVersion: string
    ): Promise<ChartImageObservation[]> {
        return db
            .select()
            .from(schema.chartImageObservations)
            .where(
                and(
                    eq(schema.chartImageObservations.repoUrl, repoUrl),
                    eq(schema.chartImageObservations.chartName, chartName),
                    eq(schema.chartImageObservations.chartVersion, chartVersion)
                )
            );
    },

    /**
     * Resolved observation digests with no SBOM under the platform cluster —
     * the platform-scan sweep's worklist. One row per digest; registry and
     * repository come along so the scan job can build a pull ref.
     */
    async unscannedDigests(
        platformClusterId: string,
        limit: number
    ): Promise<Array<{ digest: string; registry: string; repository: string }>> {
        const scanned = db
            .select({ digest: schema.images.digest })
            .from(schema.images)
            .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
            .where(eq(schema.images.clusterId, platformClusterId));

        return db
            .selectDistinctOn([schema.chartImageObservations.digest], {
                digest: sql<string>`${schema.chartImageObservations.digest}`,
                registry: schema.chartImageObservations.registry,
                repository: schema.chartImageObservations.repository,
            })
            .from(schema.chartImageObservations)
            .where(
                and(
                    isNotNull(schema.chartImageObservations.digest),
                    sql`${schema.chartImageObservations.digest} NOT IN ${scanned}`
                )
            )
            .limit(limit);
    },

    /**
     * Which of these digests carry a scanned SBOM under the platform cluster.
     * The promotion path's join from observation to measurable image.
     */
    async platformImagesForDigests(
        platformClusterId: string,
        digests: string[]
    ): Promise<Map<string, string>> {
        if (digests.length === 0) return new Map();
        const rows = await db
            .select({ digest: schema.images.digest, imageId: schema.images.id })
            .from(schema.images)
            .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
            .where(
                and(
                    eq(schema.images.clusterId, platformClusterId),
                    inArray(schema.images.digest, digests)
                )
            );
        return new Map(rows.map((r) => [r.digest, r.imageId]));
    },
};
