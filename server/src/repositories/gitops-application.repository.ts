import { eq, and, sql, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { GitopsApplication } from "../db/schema/gitops-applications.js";

/**
 * The delivery lens, sibling to `helm-release.repository.ts`.
 *
 * Deliberately shaped like the release repository — same counts, same
 * unattributed query — because the two are alternative groupings over one set
 * of `workload_containers` rows, not two hierarchies. What differs is the
 * question: a release answers "what chart packaged this, at what version", an
 * application answers "what delivers this, and where do I change it".
 *
 * Note what is **absent**: there is no `chartNameAmbiguous` equivalent. A chart
 * name is ambiguous until a repository URL is known, which is exactly the gap
 * an `Application` fills; `repoUrl` here is the unambiguous identity a chart
 * name only approximates.
 */
export interface GitopsApplicationWithCounts extends GitopsApplication {
    workloadCount: number;
    containerCount: number;
    /** Distinct images this app delivers — the unit a remediation acts on. */
    imageCount: number;
    /** How many namespaces its workloads landed in. > 1 is legal and worth showing. */
    namespaceCount: number;
}

export const gitopsApplicationRepository = {
    async findById(id: string): Promise<GitopsApplication | undefined> {
        const [row] = await db
            .select()
            .from(schema.gitopsApplications)
            .where(eq(schema.gitopsApplications.id, id));
        return row;
    },

    /**
     * Applications in the org, each with what it delivers.
     *
     * Counted through `workloads.applicationId` rather than by matching the
     * destination namespace: an app's `destinationNamespace` is where it points,
     * and a chart it renders may deploy into others.
     */
    async findAllWithCounts(orgId: string, clusterId?: string): Promise<GitopsApplicationWithCounts[]> {
        const conditions = [eq(schema.gitopsApplications.orgId, orgId)];
        if (clusterId) conditions.push(eq(schema.gitopsApplications.clusterId, clusterId));

        const rows = await db
            .select({
                application: schema.gitopsApplications,
                workloadCount: sql<number>`cast(count(DISTINCT ${schema.workloads.id}) as int)`,
                containerCount: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.id}) as int)`,
                imageCount: sql<number>`cast(count(DISTINCT ${schema.workloadContainers.imageId}) as int)`,
                namespaceCount: sql<number>`cast(count(DISTINCT ${schema.workloads.namespaceId}) as int)`,
            })
            .from(schema.gitopsApplications)
            .leftJoin(schema.workloads, eq(schema.workloads.applicationId, schema.gitopsApplications.id))
            .leftJoin(
                schema.workloadContainers,
                eq(schema.workloadContainers.workloadId, schema.workloads.id)
            )
            .where(and(...conditions))
            .groupBy(schema.gitopsApplications.id)
            .orderBy(asc(schema.gitopsApplications.name));

        return rows.map((r) => ({
            ...r.application,
            workloadCount: r.workloadCount,
            containerCount: r.containerCount,
            imageCount: r.imageCount,
            namespaceCount: r.namespaceCount,
        }));
    },

    /**
     * Workloads no GitOps tool delivers.
     *
     * A **different** set from the release repository's unmanaged count, and
     * the difference is the point: the scanner itself is `helm install`ed with
     * no GitOps tool above it, so it is unattributed here and perfectly well
     * attributed there. The workloads in both are the cluster's genuine floor.
     */
    async countUndelivered(orgId: string, clusterId?: string): Promise<{ workloads: number; containers: number }> {
        const conditions = [
            eq(schema.workloadContainers.orgId, orgId),
            sql`${schema.workloads.applicationId} IS NULL`,
        ];
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
