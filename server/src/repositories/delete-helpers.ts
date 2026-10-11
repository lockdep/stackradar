import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import { PLAN_LIMITS, getPlanLimits } from "../config/plans.js";
import { IMAGE_GC_RETENTION_DAYS } from "../config/image-gc.js";

/**
 * Delete an SBOM along with every component row, vulnerability link, and job
 * that belongs to it.
 *
 * Why not a single `DELETE FROM sboms`:
 * - Postgres FK cascade triggers fire per deleted parent row.
 *   `component_dependencies` has two FKs to `components` (parent_component_id /
 *   child_component_id) and without dedicated indexes each cascade does a
 *   sequential scan — O(components x edges). A moderately sized SBOM was timing
 *   out after 5 minutes of cascade scans.
 *
 * Why not a single statement with data-modifying CTEs:
 * - Postgres forbids updating the same row twice in a single statement. Deleting
 *   `sboms` cascades to `components`; simultaneously deleting `components` in a
 *   sibling CTE would hit the same rows and fail at execution time.
 *
 * Why not `inArray(column, componentIds)`:
 * - Drizzle's `inArray(col, arr)` compiles to `col IN ($1, ..., $N)` with one bind
 *   per element, and Postgres caps bind parameters at 65535 per statement — which
 *   real SBOMs exceed on `component_vulnerabilities`. The component set is a
 *   correlated subquery so Postgres resolves it server-side.
 */
export async function deleteSbomSubtree(sbomId: string): Promise<boolean> {
    return db.transaction(async (tx) => deleteSbomSubtreeInTx(tx, sbomId));
}

/**
 * The interior of {@link deleteSbomSubtree}, for callers that already hold a
 * transaction — the `?replace=true` supersede path deletes the old SBOM and
 * inserts its replacement atomically, so a failed parse cannot leave an image
 * with no SBOM at all.
 */
export async function deleteSbomSubtreeInTx(tx: Transaction, sbomId: string): Promise<boolean> {
    await deleteChildrenForSboms(tx, [sbomId]);

    const deleted = await tx.delete(schema.sboms).where(eq(schema.sboms.id, sbomId)).returning({ id: schema.sboms.id });
    return deleted.length > 0;
}

/**
 * Delete every component-scoped row belonging to the given sboms, plus the components
 * themselves, plus any jobs that target those sboms.
 *
 * Uses correlated subqueries (`component_id IN (SELECT id FROM components WHERE sbom_id IN …)`)
 * so we never materialize the full component id list — critical for images with tens
 * of thousands of components, which would otherwise overflow the Postgres parameter limit.
 */
async function deleteChildrenForSboms(tx: Transaction, sbomIds: string[]): Promise<void> {
    if (sbomIds.length === 0) return;

    const componentIdSubquery = tx
        .select({ id: schema.components.id })
        .from(schema.components)
        .where(inArray(schema.components.sbomId, sbomIds));

    await tx
        .delete(schema.componentVulnerabilities)
        .where(inArray(schema.componentVulnerabilities.componentId, componentIdSubquery));

    // component_licenses is the join table; the shared `licenses` catalog is
    // global and must not be deleted.
    await tx.delete(schema.componentLicenses).where(inArray(schema.componentLicenses.componentId, componentIdSubquery));

    await tx.delete(schema.componentHashes).where(inArray(schema.componentHashes.componentId, componentIdSubquery));

    await tx
        .delete(schema.componentExternalRefs)
        .where(inArray(schema.componentExternalRefs.componentId, componentIdSubquery));

    await tx
        .delete(schema.componentProperties)
        .where(inArray(schema.componentProperties.componentId, componentIdSubquery));

    await tx.delete(schema.componentDependencies).where(inArray(schema.componentDependencies.sbomId, sbomIds));

    await tx.delete(schema.components).where(inArray(schema.components.sbomId, sbomIds));

    await tx.delete(schema.jobs).where(inArray(schema.jobs.sbomId, sbomIds));
}

/**
 * Delete every image belonging to a cluster, with each image's SBOM subtree.
 *
 * The interior of cluster deletion (`cluster.repository.delete`), which since
 * ADR 0006 owns its images outright — `images.cluster_id` makes "this
 * cluster's images" a predicate, and no other tenant can be pointing at them.
 * Deletion stays explicit rather than a cascade from `clusters` because
 * `workload_containers.image_id` is `ON DELETE RESTRICT`: the caller must
 * delete the cluster's containers first, then call this, then drop the
 * cluster row, or the two cascade paths race into the restrict.
 */
export async function deleteImagesForCluster(tx: Transaction, clusterId: string): Promise<void> {
    const imageIdSubquery = tx
        .select({ id: schema.images.id })
        .from(schema.images)
        .where(eq(schema.images.clusterId, clusterId));

    const sbomIds = (
        await tx
            .select({ id: schema.sboms.id })
            .from(schema.sboms)
            .where(inArray(schema.sboms.imageId, imageIdSubquery))
    ).map((row) => row.id);

    // Explicitly, rather than letting `images`' cascade do it: the cascade
    // would fan out through `components` one parent row at a time, which is
    // the exact blow-up `deleteSbomSubtree` exists to avoid.
    await deleteChildrenForSboms(tx, sbomIds);
    if (sbomIds.length > 0) {
        await tx.delete(schema.sboms).where(inArray(schema.sboms.id, sbomIds));
    }

    // `jobs` and `vulnerability_scan_runs` still reference images by
    // `image_id`; both cascade, and both are small per image.
    await tx.delete(schema.images).where(eq(schema.images.clusterId, clusterId));
}

/**
 * Reclaim images nothing refers to any more, and everything hanging off them.
 *
 * Cluster deletion removes its images explicitly now (ADR 0006), so this
 * sweep is no longer what frees an image whose org walked away. What it still
 * reclaims — and why its mechanics survive the cutover unchanged — is the
 * image whose *cluster still exists* but whose digest nothing mentions any
 * more: rollout leftovers and uploads that never got inventoried.
 *
 * **Two conditions, and both are load-bearing:**
 *
 * - *No `workload_containers` reference it.* Reachability from any container
 *   is what keeps an image alive while it runs.
 * - *`last_seen_at` older than the org's archive window.* Reachability alone
 *   would be wrong: inventory is a full set replacement, so a digest drops to
 *   zero containers for the seconds a rollout takes, and a GC that trusted
 *   only the join would throw away an image that is back before the sweep
 *   finishes — costing a re-pull and a re-scan for nothing. The window is
 *   also the only protection for an upload-before-inventory image, which
 *   legitimately has zero containers until its cluster's next report and is
 *   aged on upload recency instead.
 *
 * The window is **per plan**, not one cutoff: the SBOM archive — "what was
 * running in June, and what was in it" — is part of what a paid plan's
 * history window buys (`historyDays`, `config/plans.ts`), floored by
 * `IMAGE_GC_RETENTION_DAYS`. The SQL below is the same rule
 * `imageGcRetentionDays` computes for the admin countdown; an unknown plan
 * value falls to the ELSE arm, i.e. the free window, matching
 * `getPlanLimits`'s fallback.
 *
 * Per-image transaction, not one big statement: each image's subtree is an
 * independent unit of work, a sweep interrupted halfway leaves no half-deleted
 * image behind, and one pathological image cannot hold a lock over all the
 * others.
 */
export async function deleteOrphanedImages(limit: number): Promise<number> {
    const planWindow = sql.join(
        // `getPlanLimits`, not the table: in the community edition every
        // stored plan value maps to the one community window.
        Object.keys(PLAN_LIMITS).map((plan) => sql`WHEN ${plan} THEN ${getPlanLimits(plan).historyDays}::int`),
        sql` `,
    );
    const candidates = await db
        .select({ id: schema.images.id })
        .from(schema.images)
        .innerJoin(schema.clusters, eq(schema.images.clusterId, schema.clusters.id))
        .innerJoin(schema.organizations, eq(schema.images.orgId, schema.organizations.id))
        .where(
            and(
                sql`${schema.images.lastSeenAt} < now() - (GREATEST(${IMAGE_GC_RETENTION_DAYS}::int, CASE ${schema.organizations.plan} ${planWindow} ELSE ${IMAGE_GC_RETENTION_DAYS}::int END) * interval '1 day')`,
                notExists(
                    db
                        .select({ one: sql`1` })
                        .from(schema.workloadContainers)
                        .where(eq(schema.workloadContainers.imageId, schema.images.id)),
                ),
                // Platform-cluster images (the candidate chart scans) are
                // referenced by `chart_image_observations` digests, never by
                // containers — to this sweep every one of them looks orphaned
                // forever. Deleting them would silently demote measured
                // platform-render suggestions back to unmeasured and put the
                // nightly scan sweep into a delete/re-scan churn loop.
                eq(schema.clusters.system, false),
            ),
        )
        .orderBy(schema.images.lastSeenAt)
        .limit(limit);

    let deleted = 0;
    for (const candidate of candidates) {
        if (await deleteOrphanedImage(candidate.id)) deleted++;
    }
    return deleted;
}

/**
 * Delete one orphaned image, re-checking under a lock that it is still orphaned.
 *
 * The candidate scan above runs outside any transaction, so an image can be
 * deployed again between being listed and being deleted. `SELECT … FOR UPDATE`
 * closes that window from both sides: it conflicts with the `FOR KEY SHARE` an
 * inserting `workload_containers` row takes on its parent, so a concurrent
 * inventory write either lands before us — and the re-check below sees the
 * container and skips the image — or blocks until we commit, finds the digest
 * gone, and re-creates the image row through the same `ON CONFLICT` path it
 * already uses. Neither order can leave a container pointing at a deleted image.
 *
 * Returns false when the image was claimed in that window, or already gone.
 */
async function deleteOrphanedImage(imageId: string): Promise<boolean> {
    return db.transaction(async (tx) => {
        const [locked] = await tx
            .select({ id: schema.images.id })
            .from(schema.images)
            .where(eq(schema.images.id, imageId))
            .for("update");
        if (!locked) return false;

        const [claimed] = await tx
            .select({ id: schema.workloadContainers.id })
            .from(schema.workloadContainers)
            .where(eq(schema.workloadContainers.imageId, imageId))
            .limit(1);
        if (claimed) return false;

        // One SBOM per image (`sboms_image_id_unique`), but this reads as a set
        // so it stays correct if that ever loosens.
        const sbomIds = (
            await tx.select({ id: schema.sboms.id }).from(schema.sboms).where(eq(schema.sboms.imageId, imageId))
        ).map((row) => row.id);

        // Explicitly, rather than letting `images`' cascade do it: the cascade
        // would fan out through `components` one parent row at a time, which is
        // the exact blow-up `deleteSbomSubtree` exists to avoid.
        await deleteChildrenForSboms(tx, sbomIds);
        if (sbomIds.length > 0) {
            await tx.delete(schema.sboms).where(inArray(schema.sboms.id, sbomIds));
        }

        // `jobs` and `vulnerability_scan_runs` still reference the image by
        // `image_id`; both cascade, and both are small per image.
        await tx.delete(schema.images).where(eq(schema.images.id, imageId));
        return true;
    });
}
