import { eq, and, sql, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Namespace } from "../db/schema/namespaces.js";

export interface NamespaceWithCounts extends Namespace {
    workloadCount: number;
    containerCount: number;
    /** Containers whose image has an SBOM. `<= containerCount` by construction. */
    scannedCount: number;
}

export const namespaceRepository = {
    async findById(id: string): Promise<Namespace | undefined> {
        const [row] = await db.select().from(schema.namespaces).where(eq(schema.namespaces.id, id));
        return row;
    },

    /**
     * The folder view: every namespace with what is running in it.
     *
     * `LEFT JOIN` all the way down so a namespace with **zero** workloads still
     * appears — the state the old `type: "group"` row could not represent,
     * because a group with no children was indistinguishable from one that was
     * never created. An empty namespace is real and worth showing: it is where
     * a scanner with partial RBAC becomes visible.
     *
     * `scannedCount` counts *containers whose image has an SBOM*, not distinct
     * scanned images. The two diverge the moment two containers share an image,
     * and the ratio the UI draws is over containers, so it is computed over
     * containers rather than reusing the cheaper number.
     */
    async findAllWithCounts(orgId: string, clusterId?: string): Promise<NamespaceWithCounts[]> {
        const conditions = [eq(schema.namespaces.orgId, orgId)];
        if (clusterId) conditions.push(eq(schema.namespaces.clusterId, clusterId));

        const rows = await db
            .select({
                namespace: schema.namespaces,
                workloadCount: sql<number>`cast(count(DISTINCT ${schema.workloads.id}) as int)`,
                containerCount: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.id}) as int)`,
                scannedCount: sql<number>`cast(count(DISTINCT CASE WHEN ${schema.sboms.id} IS NOT NULL THEN ${schema.workloadContainers.id} END) as int)`,
            })
            .from(schema.namespaces)
            .leftJoin(schema.workloads, eq(schema.workloads.namespaceId, schema.namespaces.id))
            .leftJoin(
                schema.workloadContainers,
                eq(schema.workloadContainers.workloadId, schema.workloads.id)
            )
            .leftJoin(schema.sboms, eq(schema.sboms.imageId, schema.workloadContainers.imageId))
            .where(and(...conditions))
            .groupBy(schema.namespaces.id)
            .orderBy(asc(schema.namespaces.name));

        return rows.map((r) => ({
            ...r.namespace,
            workloadCount: r.workloadCount,
            containerCount: r.containerCount,
            scannedCount: r.scannedCount,
        }));
    },
};
