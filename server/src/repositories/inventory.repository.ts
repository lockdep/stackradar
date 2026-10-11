import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import type { GitopsTool } from "../db/schema/gitops-applications.js";
import { parseImageRef } from "../lib/image-ref.js";
import { readSlotState, recordSlotHistory } from "./container-history.repository.js";
import { slotKey, type SlotContainer } from "../lib/container-slots.js";
import { chunk } from "../lib/chunk.js";

/**
 * Writing an inventory report.
 *
 * Under [ADR 0004](../../../docs/adr/0004-image-as-the-unit-of-identity.md) the
 * inventory is no longer a progress hint feeding a side table — it is the
 * **primary write path** for `namespaces`, `workloads`, `workload_containers`,
 * `helm_releases` and `gitops_applications`. The wire format it consumes is
 * specified in [contracts/inventory-v3.md](../../../docs/contracts/inventory-v3.md).
 */

export interface ReleaseInput {
    name: string;
    /** The **release's** namespace, not the workload's. */
    namespace: string;
    chartName: string | null;
    chartVersion: string | null;
    /** The **app's** version. Distinct from `chartVersion` even when equal. */
    appVersion: string | null;
    repoUrl: string | null;
}

/**
 * A GitOps application — the delivery layer, written independently of the
 * release. See `gitops-applications.ts` for why the two are separate tables.
 */
export interface ApplicationInput {
    name: string;
    /** The **application object's** namespace, e.g. `argocd`. */
    namespace: string;
    tool: GitopsTool;
    repoUrl: string | null;
    targetRevision: string | null;
    chart: string | null;
    path: string | null;
    destinationNamespace: string | null;
}

export interface ContainerInput {
    name: string;
    init: boolean;
    imageRef: string;
    imageDigest: string;
    imageTag: string | null;
    registry: string | null;
    repository: string | null;
    runningPods: number | null;
}

export interface WorkloadInput {
    /** `null` when `ownerReferences` could not be resolved. Never the literal `"Pod"`. */
    kind: string | null;
    name: string;
    /** Natural key into the report's own `releases` list, or null. */
    release: { name: string; namespace: string } | null;
    /** Natural key into the report's own `applications` list, or null. */
    application: { name: string; namespace: string } | null;
    runningPods: number | null;
    firstStartedAt: Date | null;
    labels: Record<string, string> | null;
    containers: ContainerInput[];
}

export interface NamespaceInput {
    name: string;
    /** `null` = not collected (RBAC), `{}` = collected and empty. Not the same thing. */
    labels: Record<string, string> | null;
    workloads: WorkloadInput[];
}

export interface ScanFailureInput {
    imageDigest: string;
    code: string;
    registryHost: string | null;
}

export interface InventoryReportInput {
    releases: ReleaseInput[];
    applications: ApplicationInput[];
    namespaces: NamespaceInput[];
    scanFailures: ScanFailureInput[];
}

export interface InventoryCounts {
    namespaces: number;
    workloads: number;
    containers: number;
    releases: number;
    applications: number;
    images: number;
}

/**
 * Rows are written in batches rather than one statement each: a large fleet
 * reports thousands of containers, and Postgres's 65535-parameter ceiling is
 * per statement, not per transaction.
 */
const UPSERT_BATCH = 500;

const releaseKey = (namespace: string, name: string) => `${namespace}\u0000${name}`;

/** Same natural key, over the application object's own namespace. */
const applicationKey = (namespace: string, name: string) => `${namespace}\u0000${name}`;

export const inventoryRepository = {
    /**
     * Replace a cluster's inventory with the report the scanner just sent.
     *
     * **Full set replacement, per cluster**, and the cluster comes from the API
     * key rather than the body. The report is the whole truth about the cluster
     * at one instant, so rather than diffing identities in application code
     * every row it contains is stamped with a single `reportedAt`; anything
     * still carrying an older stamp afterwards is a thing that has gone away,
     * and is deleted in one predicate per table.
     *
     * `firstSeenAt` is left alone on conflict — it is the only column that
     * would otherwise lose its meaning on the first re-report, and it is what
     * separates a container that is mid-pull from one that has been failing to
     * scan for four days.
     *
     * Images are **never deleted here.** A digest whose last workload vanished
     * during a rollout is back seconds later, and dropping its SBOM would mean
     * re-pulling and re-scanning it; `workload_containers.image_id` is
     * `ON DELETE RESTRICT` so an in-use image cannot be removed by accident
     * either. Whether an image still runs anywhere is a question the read path
     * answers with `deployedImages`, not one storage has to enforce.
     *
     * What the report does leave behind is `images.last_seen_at`, stamped on
     * every digest it mentions. Reclaiming the ones nothing has mentioned for
     * a long time is the GC's job, off this path — see `deleteOrphanedImages`
     * in `delete-helpers.ts`.
     */
    async replaceForCluster(orgId: string, clusterId: string, report: InventoryReportInput): Promise<InventoryCounts> {
        const reportedAt = new Date();

        return db.transaction(async (tx) => {
            /*
             * The before-state, read before the upsert destroys it. The
             * activity feed's container events are a diff of this against
             * what the report writes; nothing after the
             * upsert can reconstruct which digest a slot ran a minute ago.
             */
            const before = await readSlotState(tx, clusterId);

            const releaseIds = await upsertReleases(tx, orgId, clusterId, report.releases, reportedAt);
            const applicationIds = await upsertApplications(tx, orgId, clusterId, report.applications, reportedAt);
            const namespaceIds = await upsertNamespaces(tx, orgId, clusterId, report.namespaces, reportedAt);
            const imageIds = await upsertImages(tx, orgId, clusterId, report, reportedAt);
            await recordScanFailures(tx, imageIds, report.scanFailures, reportedAt);
            const workloadIds = await upsertWorkloads(
                tx,
                orgId,
                report.namespaces,
                namespaceIds,
                releaseIds,
                applicationIds,
                reportedAt,
            );
            const {
                count: containerCount,
                slots: after,
                slotWorkloadIds,
            } = await upsertContainers(
                tx,
                orgId,
                report.namespaces,
                namespaceIds,
                workloadIds,
                imageIds,
                before,
                reportedAt,
            );

            await pruneStale(tx, clusterId, reportedAt);

            await recordSlotHistory(tx, orgId, clusterId, before, after, slotWorkloadIds, reportedAt);

            // Set once: the start of what we have observed of this cluster,
            // which is what makes an exposure figure a lower bound or not.
            await tx
                .update(schema.clusters)
                .set({ firstInventoryAt: reportedAt })
                .where(and(eq(schema.clusters.id, clusterId), isNull(schema.clusters.firstInventoryAt)));

            return {
                namespaces: namespaceIds.size,
                workloads: workloadIds.size,
                containers: containerCount,
                releases: releaseIds.size,
                applications: applicationIds.size,
                images: imageIds.size,
            };
        });
    },
};

async function upsertReleases(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    releases: ReleaseInput[],
    reportedAt: Date,
): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (releases.length === 0) return ids;

    for (const batch of chunk(releases, UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.helmReleases)
            .values(
                batch.map((r) => ({
                    orgId,
                    clusterId,
                    namespace: r.namespace,
                    name: r.name,
                    chartName: r.chartName,
                    chartVersion: r.chartVersion,
                    appVersion: r.appVersion,
                    repoUrl: r.repoUrl,
                    firstSeenAt: reportedAt,
                    lastSeenAt: reportedAt,
                })),
            )
            .onConflictDoUpdate({
                target: [schema.helmReleases.clusterId, schema.helmReleases.namespace, schema.helmReleases.name],
                set: {
                    chartName: sql`excluded.chart_name`,
                    chartVersion: sql`excluded.chart_version`,
                    appVersion: sql`excluded.app_version`,
                    repoUrl: sql`excluded.repo_url`,
                    lastSeenAt: reportedAt,
                    updatedAt: reportedAt,
                },
            })
            .returning({
                id: schema.helmReleases.id,
                namespace: schema.helmReleases.namespace,
                name: schema.helmReleases.name,
            });

        for (const row of rows) ids.set(releaseKey(row.namespace, row.name), row.id);
    }

    return ids;
}

/**
 * Find-or-create the report's GitOps applications.
 *
 * Written before workloads, like releases, because a workload references it.
 * The `set` clause is `excluded.*` verbatim rather than `coalesce`: an app that
 * loses its repository URL — the `Application` CRD removed, the RBAC revoked —
 * must report `null` again rather than keep serving the last value it happened
 * to have. Same reasoning as `namespaces.labels`.
 */
async function upsertApplications(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    applications: ApplicationInput[],
    reportedAt: Date,
): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (applications.length === 0) return ids;

    for (const batch of chunk(applications, UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.gitopsApplications)
            .values(
                batch.map((a) => ({
                    orgId,
                    clusterId,
                    namespace: a.namespace,
                    name: a.name,
                    tool: a.tool,
                    repoUrl: a.repoUrl,
                    targetRevision: a.targetRevision,
                    chart: a.chart,
                    path: a.path,
                    destinationNamespace: a.destinationNamespace,
                    firstSeenAt: reportedAt,
                    lastSeenAt: reportedAt,
                })),
            )
            .onConflictDoUpdate({
                target: [
                    schema.gitopsApplications.clusterId,
                    schema.gitopsApplications.namespace,
                    schema.gitopsApplications.name,
                ],
                set: {
                    tool: sql`excluded.tool`,
                    repoUrl: sql`excluded.repo_url`,
                    targetRevision: sql`excluded.target_revision`,
                    chart: sql`excluded.chart`,
                    path: sql`excluded.path`,
                    destinationNamespace: sql`excluded.destination_namespace`,
                    lastSeenAt: reportedAt,
                    updatedAt: reportedAt,
                },
            })
            .returning({
                id: schema.gitopsApplications.id,
                namespace: schema.gitopsApplications.namespace,
                name: schema.gitopsApplications.name,
            });

        for (const row of rows) ids.set(applicationKey(row.namespace, row.name), row.id);
    }

    return ids;
}

async function upsertNamespaces(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    namespaces: NamespaceInput[],
    reportedAt: Date,
): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    if (namespaces.length === 0) return ids;

    for (const batch of chunk(namespaces, UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.namespaces)
            .values(
                batch.map((n) => ({
                    orgId,
                    clusterId,
                    name: n.name,
                    labels: n.labels,
                    firstSeenAt: reportedAt,
                    lastSeenAt: reportedAt,
                })),
            )
            .onConflictDoUpdate({
                target: [schema.namespaces.clusterId, schema.namespaces.name],
                set: {
                    // `excluded.labels` verbatim, so a report that says "not
                    // collected" (null) overwrites a previous `{}` and vice
                    // versa. `coalesce` here would make an RBAC regression
                    // invisible by keeping the last labels we happened to see.
                    labels: sql`excluded.labels`,
                    lastSeenAt: reportedAt,
                    updatedAt: reportedAt,
                },
            })
            .returning({ id: schema.namespaces.id, name: schema.namespaces.name });

        for (const row of rows) ids.set(row.name, row.id);
    }

    return ids;
}

/**
 * Find-or-create every image the report mentions, keyed by
 * `(clusterId, digest)`.
 *
 * The win is one row per digest **per cluster** (ADR 0006): an image running
 * in five namespaces of this cluster is one image, one SBOM, one matching
 * pass. The same digest in another cluster is deliberately another row —
 * that separation is the isolation boundary, not a missed dedup.
 */
async function upsertImages(
    tx: Transaction,
    orgId: string,
    clusterId: string,
    report: InventoryReportInput,
    reportedAt: Date,
): Promise<Map<string, string>> {
    const byDigest = new Map<string, { digest: string; registry: string | null; repository: string | null }>();
    for (const ns of report.namespaces) {
        for (const w of ns.workloads) {
            for (const c of w.containers) {
                if (!byDigest.has(c.imageDigest)) {
                    // The ref is authoritative for provenance — it comes from
                    // the runtime's `imageID` and always names the real
                    // repository. The container's explicit fields are parsed by
                    // the agent from a *display* name, which for a digest-pinned
                    // pod is a bare config hash: agents ≤0.1.7 sent
                    // `repository: 'sha256'` from exactly that. A digest-only
                    // ref parses to an empty repository and must not clobber an
                    // explicit one, hence `||`.
                    const parsed = parseImageRef(c.imageRef);
                    byDigest.set(c.imageDigest, {
                        digest: c.imageDigest,
                        registry: parsed.registry ?? c.registry,
                        repository: (parsed.repository || c.repository) ?? null,
                    });
                }
            }
        }
    }

    const ids = new Map<string, string>();
    if (byDigest.size === 0) return ids;

    for (const batch of chunk([...byDigest.values()], UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.images)
            .values(
                batch.map((image) => ({ ...image, orgId, clusterId, firstSeenAt: reportedAt, lastSeenAt: reportedAt })),
            )
            .onConflictDoUpdate({
                target: [schema.images.clusterId, schema.images.digest],
                set: {
                    // Backfill only. A digest's registry is descriptive, and a
                    // mirror reporting a different one must not overwrite the
                    // original provenance.
                    registry: sql`coalesce(${schema.images.registry}, excluded.registry)`,
                    repository: sql`coalesce(${schema.images.repository}, excluded.repository)`,
                    // Not backfill: every report is fresh evidence the digest
                    // is still deployed, and it is what the GC ages on. An
                    // image that keeps being reported never grows old.
                    lastSeenAt: reportedAt,
                },
            })
            .returning({ id: schema.images.id, digest: schema.images.digest });

        for (const row of rows) ids.set(row.digest, row.id);
    }

    return ids;
}

/**
 * Pin each reported failure onto its `(cluster, digest)` image row.
 *
 * Set-only, never clear: the report's `scanFailures` is what the scanner
 * currently *remembers* failing, and a restarted scanner remembers nothing —
 * treating absence as recovery would erase a still-true error on every
 * restart. The one thing that proves recovery is a successful SBOM upload for
 * the digest, and that path (`imageRepository.clearScanError`) is what clears
 * these columns. Per-row updates are fine here: a report carries a handful of
 * failures, not thousands.
 */
async function recordScanFailures(
    tx: Transaction,
    imageIds: Map<string, string>,
    failures: ScanFailureInput[],
    reportedAt: Date,
): Promise<void> {
    for (const failure of failures) {
        // The producer filters failures to digests its containers carry, so a
        // miss here is a malformed report — dropped rather than 400ing, since
        // the field is display-only and the inventory itself is good.
        const imageId = imageIds.get(failure.imageDigest);
        if (!imageId) continue;
        await tx
            .update(schema.images)
            .set({
                lastScanErrorCode: failure.code,
                lastScanErrorHost: failure.registryHost,
                lastScanErrorAt: reportedAt,
                updatedAt: reportedAt,
            })
            .where(eq(schema.images.id, imageId));
    }
}

/** `namespaceId\0kind\0name`, with kind spelled `\0` when unresolved. */
const workloadKey = (namespaceId: string, kind: string | null, name: string) =>
    `${namespaceId}\u0000${kind ?? ""}\u0000${name}`;

async function upsertWorkloads(
    tx: Transaction,
    orgId: string,
    namespaces: NamespaceInput[],
    namespaceIds: Map<string, string>,
    releaseIds: Map<string, string>,
    applicationIds: Map<string, string>,
    reportedAt: Date,
): Promise<Map<string, string>> {
    type Row = {
        orgId: string;
        namespaceId: string;
        kind: string | null;
        name: string;
        releaseId: string | null;
        applicationId: string | null;
        runningPods: number | null;
        labels: Record<string, string> | null;
        firstStartedAt: Date | null;
        firstSeenAt: Date;
        lastSeenAt: Date;
    };

    const resolved: Row[] = [];
    for (const ns of namespaces) {
        const namespaceId = namespaceIds.get(ns.name);
        if (!namespaceId) continue;
        for (const w of ns.workloads) {
            resolved.push({
                orgId,
                namespaceId,
                kind: w.kind,
                name: w.name,
                releaseId: w.release ? (releaseIds.get(releaseKey(w.release.namespace, w.release.name)) ?? null) : null,
                applicationId: w.application
                    ? (applicationIds.get(applicationKey(w.application.namespace, w.application.name)) ?? null)
                    : null,
                runningPods: w.runningPods,
                labels: w.labels,
                firstStartedAt: w.firstStartedAt,
                firstSeenAt: reportedAt,
                lastSeenAt: reportedAt,
            });
        }
    }

    const ids = new Map<string, string>();
    if (resolved.length === 0) return ids;

    const set = {
        releaseId: sql`excluded.release_id`,
        applicationId: sql`excluded.application_id`,
        runningPods: sql`excluded.running_pods`,
        labels: sql`excluded.labels`,
        firstStartedAt: sql`excluded.first_started_at`,
        lastSeenAt: reportedAt,
        updatedAt: reportedAt,
    };

    /*
     * Two passes, because `workloads` carries two *partial* unique indexes —
     * one for resolved kinds and one for unresolved — and `ON CONFLICT` names
     * exactly one index arbiter. Postgres treats NULL as distinct in a
     * composite unique constraint, so a single UNIQUE(namespace_id, kind, name)
     * would let two kind-unresolved workloads with the same name both insert.
     */
    const withKind = resolved.filter((r) => r.kind !== null);
    const withoutKind = resolved.filter((r) => r.kind === null);

    for (const batch of chunk(withKind, UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.workloads)
            .values(batch)
            .onConflictDoUpdate({
                target: [schema.workloads.namespaceId, schema.workloads.kind, schema.workloads.name],
                targetWhere: sql`kind IS NOT NULL`,
                set,
            })
            .returning({
                id: schema.workloads.id,
                namespaceId: schema.workloads.namespaceId,
                kind: schema.workloads.kind,
                name: schema.workloads.name,
            });
        for (const row of rows) ids.set(workloadKey(row.namespaceId, row.kind, row.name), row.id);
    }

    for (const batch of chunk(withoutKind, UPSERT_BATCH)) {
        const rows = await tx
            .insert(schema.workloads)
            .values(batch)
            .onConflictDoUpdate({
                target: [schema.workloads.namespaceId, schema.workloads.name],
                targetWhere: sql`kind IS NULL`,
                set,
            })
            .returning({
                id: schema.workloads.id,
                namespaceId: schema.workloads.namespaceId,
                kind: schema.workloads.kind,
                name: schema.workloads.name,
            });
        for (const row of rows) ids.set(workloadKey(row.namespaceId, row.kind, row.name), row.id);
    }

    return ids;
}

/**
 * Also returns the written containers in **slot** form — the after-state the
 * history diff needs — built in the same loop so the two cannot disagree
 * about what was written. A surviving (slot, digest) keeps the before-state's
 * `firstSeenAt`, exactly as the upsert below leaves `first_seen_at` alone.
 */
async function upsertContainers(
    tx: Transaction,
    orgId: string,
    namespaces: NamespaceInput[],
    namespaceIds: Map<string, string>,
    workloadIds: Map<string, string>,
    imageIds: Map<string, string>,
    before: SlotContainer[],
    reportedAt: Date,
): Promise<{ count: number; slots: SlotContainer[]; slotWorkloadIds: Map<string, string> }> {
    const rows: Array<typeof schema.workloadContainers.$inferInsert> = [];
    const slots: SlotContainer[] = [];
    const slotWorkloadIds = new Map<string, string>();
    const firstSeen = new Map(before.map((c) => [`${slotKey(c)}@${c.digest}`, c.firstSeenAt]));

    for (const ns of namespaces) {
        const namespaceId = namespaceIds.get(ns.name);
        if (!namespaceId) continue;
        for (const w of ns.workloads) {
            const workloadId = workloadIds.get(workloadKey(namespaceId, w.kind, w.name));
            if (!workloadId) continue;
            for (const c of w.containers) {
                const imageId = imageIds.get(c.imageDigest);
                if (!imageId) continue;
                const slot: SlotContainer = {
                    namespace: ns.name,
                    workloadKind: w.kind,
                    workloadName: w.name,
                    containerName: c.name,
                    init: c.init,
                    imageId,
                    digest: c.imageDigest,
                    // Same precedence as `upsertImages`: the ref names the
                    // real repository; the explicit field is the fallback.
                    repository: (parseImageRef(c.imageRef).repository || c.repository) ?? null,
                    imageTag: c.imageTag,
                    imageRef: c.imageRef,
                    firstSeenAt: reportedAt,
                };
                slot.firstSeenAt = firstSeen.get(`${slotKey(slot)}@${slot.digest}`) ?? reportedAt;
                slots.push(slot);
                slotWorkloadIds.set(slotKey(slot), workloadId);
                rows.push({
                    orgId,
                    workloadId,
                    name: c.name,
                    init: c.init,
                    imageId,
                    imageRef: c.imageRef,
                    imageTag: c.imageTag,
                    runningPods: c.runningPods,
                    firstSeenAt: reportedAt,
                    lastSeenAt: reportedAt,
                });
            }
        }
    }

    if (rows.length === 0) return { count: 0, slots, slotWorkloadIds };

    for (const batch of chunk(rows, UPSERT_BATCH)) {
        await tx
            .insert(schema.workloadContainers)
            .values(batch)
            .onConflictDoUpdate({
                target: [
                    schema.workloadContainers.workloadId,
                    schema.workloadContainers.name,
                    schema.workloadContainers.imageId,
                ],
                set: {
                    init: sql`excluded.init`,
                    imageRef: sql`excluded.image_ref`,
                    imageTag: sql`excluded.image_tag`,
                    runningPods: sql`excluded.running_pods`,
                    lastSeenAt: reportedAt,
                    updatedAt: reportedAt,
                },
            });
    }

    return { count: rows.length, slots, slotWorkloadIds };
}

/**
 * Delete everything the report did not mention, bottom-up.
 *
 * Bottom-up because the FKs are `cascade` on the containment chain and would
 * otherwise fire per-row triggers; explicit set-based deletes against indexed
 * columns are the same pattern `delete-helpers.ts` uses and for the same
 * reason.
 *
 * Releases and applications go last: both references are `ON DELETE SET NULL`,
 * so a release or an app that disappears leaves its workloads standing as
 * unattributed rather than taking them with it. That is the correct reading —
 * the workload is still running; we have merely lost the thing that claimed it.
 */
async function pruneStale(tx: Transaction, clusterId: string, reportedAt: Date): Promise<void> {
    const namespaceIdsInCluster = tx
        .select({ id: schema.namespaces.id })
        .from(schema.namespaces)
        .where(eq(schema.namespaces.clusterId, clusterId));

    const workloadIdsInCluster = tx
        .select({ id: schema.workloads.id })
        .from(schema.workloads)
        .where(inArray(schema.workloads.namespaceId, namespaceIdsInCluster));

    await tx
        .delete(schema.workloadContainers)
        .where(
            and(
                inArray(schema.workloadContainers.workloadId, workloadIdsInCluster),
                lt(schema.workloadContainers.lastSeenAt, reportedAt),
            ),
        );

    await tx
        .delete(schema.workloads)
        .where(
            and(
                inArray(schema.workloads.namespaceId, namespaceIdsInCluster),
                lt(schema.workloads.lastSeenAt, reportedAt),
            ),
        );

    await tx
        .delete(schema.namespaces)
        .where(and(eq(schema.namespaces.clusterId, clusterId), lt(schema.namespaces.lastSeenAt, reportedAt)));

    await tx
        .delete(schema.helmReleases)
        .where(and(eq(schema.helmReleases.clusterId, clusterId), lt(schema.helmReleases.lastSeenAt, reportedAt)));

    await tx
        .delete(schema.gitopsApplications)
        .where(
            and(
                eq(schema.gitopsApplications.clusterId, clusterId),
                lt(schema.gitopsApplications.lastSeenAt, reportedAt),
            ),
        );
}
