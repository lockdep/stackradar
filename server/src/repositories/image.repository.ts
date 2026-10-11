import { eq, and, inArray, isNotNull, isNull, count, max, sql } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
import type { Image, NewImage } from "../db/schema/images.js";
import {
    emptySeverityCounts,
    severityCountsByImage,
    severityCountsForScope,
    type SeverityCounts,
} from "../db/findings.js";
import { imageRiskScores, emptyRiskRollup, type RiskRollup } from "../db/risk.js";
import { isUniqueViolation } from "../lib/pg-errors.js";

/** An image plus what is known about it: its SBOM, its findings, where it runs. */
export interface ImageWithStats extends Image {
    /**
     * The cluster the image belongs to, by name. Under ADR 0006 the same
     * digest in N clusters is N rows, and the name is what tells them apart
     * on the images view.
     */
    clusterName: string;
    sbomId: string | null;
    /**
     * When the SBOM was generated — the inventory's age, not the findings'.
     * An SBOM is written once per digest and never regenerated, so this date
     * only moves when the image itself changes.
     */
    scannedAt: string | null;
    /**
     * When the SBOM was last matched against the OSV mirror. This is the
     * findings' freshness: the mirror syncs hourly and every changed sync
     * re-queues a match, so this moves while `scannedAt` stands still. `null`
     * when no scan run has completed yet.
     */
    lastMatchedAt: string | null;
    componentCount: number;
    /** `null` means "not scanned yet" — see `scannedImageIds`. Never conflate with zeroes. */
    vulnerabilities: SeverityCounts | null;
    /** How many `workload_containers` reference this image. */
    containerCount: number;
    /** Distinct tags deployments asked for. A digest may carry several, or none. */
    tags: string[];
    /** Names of the namespaces it runs in — what the images list filters by. */
    namespaces: string[];
    /**
     * The image's total risk — the unbounded sum of its findings' scores
     * (ADR 0007) — with the working shown. `null` under
     * the same condition as `vulnerabilities` — nobody has scanned it.
     *
     * This is the number the remediation view orders by, and it is the right
     * one to order by here specifically because the row is an *image*: a
     * finding keys on a digest, so an image's score needs no un-multiplying and
     * means the same thing whether the digest runs in one namespace or twenty.
     * "How many places it runs" is `containerCount`, in the next column.
     */
    risk: RiskRollup | null;
}

/**
 * Which of these images we can honestly report a vulnerability count for.
 *
 * Same rule as before the cutover, moved from projects to images: a count of
 * zero means "we looked and found nothing", and `null` means "nobody has
 * looked". Either a scan run or a raw match row is evidence a scan happened;
 * requiring both would let a swallowed bookkeeping error blank out a real
 * count, and requiring neither would report an unscanned image as clean.
 *
 * Exported because the admin dashboard's image table has to draw the same
 * distinction over a different set of images. Two copies of this rule would
 * drift, and the direction they drift is a dashboard reporting an unscanned
 * image as having no vulnerabilities.
 */
export async function scannedImageIds(sbomIdsByImage: Map<string, string>): Promise<Set<string>> {
    const sbomIds = [...sbomIdsByImage.values()];
    if (sbomIds.length === 0) return new Set();

    const [runs, matched] = await Promise.all([
        db
            .selectDistinct({ imageId: schema.vulnerabilityScanRuns.imageId })
            .from(schema.vulnerabilityScanRuns)
            .where(
                and(
                    inArray(schema.vulnerabilityScanRuns.sbomId, sbomIds),
                    sql`${schema.vulnerabilityScanRuns.status} <> 'failed'`,
                ),
            ),
        db
            .selectDistinct({ imageId: schema.sboms.imageId })
            .from(schema.componentVulnerabilities)
            .innerJoin(schema.components, eq(schema.componentVulnerabilities.componentId, schema.components.id))
            .innerJoin(schema.sboms, eq(schema.components.sbomId, schema.sboms.id))
            .where(inArray(schema.sboms.id, sbomIds)),
    ]);

    return new Set([...runs, ...matched].map((r) => r.imageId));
}

/**
 * When each image was last matched against the OSV mirror — the newest
 * completed, non-failed scan run per image.
 *
 * Keyed on `imageId` rather than `sbomId`: an image has one SBOM for life
 * (`sboms_image_id_unique`), and the run history is the record of that one
 * SBOM being re-matched as the mirror moves. Shared by the image and
 * workload read paths so five containers on one digest report the same
 * timestamp for the same reason they report the same severity counts.
 */
export async function latestScanCompletionByImage(imageIds: string[]): Promise<Map<string, Date>> {
    if (imageIds.length === 0) return new Map();

    const rows = await db
        .select({
            imageId: schema.vulnerabilityScanRuns.imageId,
            lastMatchedAt: max(schema.vulnerabilityScanRuns.completedAt),
        })
        .from(schema.vulnerabilityScanRuns)
        .where(
            and(
                inArray(schema.vulnerabilityScanRuns.imageId, imageIds),
                sql`${schema.vulnerabilityScanRuns.status} <> 'failed'`,
            ),
        )
        .groupBy(schema.vulnerabilityScanRuns.imageId);

    return new Map(rows.flatMap((r) => (r.lastMatchedAt ? [[r.imageId, r.lastMatchedAt] as const] : [])));
}

export const imageRepository = {
    async findById(id: string): Promise<Image | undefined> {
        const [row] = await db.select().from(schema.images).where(eq(schema.images.id, id));
        return row;
    },

    /**
     * Race-safe find-or-create by `(clusterId, digest)`.
     *
     * This is the hot path: every container in every inventory report and
     * every SBOM upload lands here, and a cluster's inventory report can race
     * its own scanner's upload on the same digest.
     * `images_cluster_digest_unique` is what makes that safe — the loser of
     * the race reads the winner's row rather than failing.
     *
     * `registry` and `repository` are filled in when the existing row is
     * missing them, so an image first seen through a path that only knew the
     * digest gains its provenance later without a second write path.
     */
    /**
     * A successful SBOM upload is the **only** thing that clears a recorded
     * scan failure — the inventory path only ever sets one (see
     * `schema/images.ts`). Conditional on a failure being present, so the
     * common upload writes nothing.
     */
    async clearScanError(imageId: string, tx?: Transaction): Promise<void> {
        const conn = tx ?? db;
        await conn
            .update(schema.images)
            .set({
                lastScanErrorCode: null,
                lastScanErrorHost: null,
                lastScanErrorAt: null,
                updatedAt: new Date(),
            })
            .where(and(eq(schema.images.id, imageId), isNotNull(schema.images.lastScanErrorAt)));
    },

    async findOrCreateByDigest(data: NewImage, tx?: Transaction): Promise<Image> {
        const conn = tx ?? db;
        const identity = and(eq(schema.images.clusterId, data.clusterId), eq(schema.images.digest, data.digest));
        const existing = await conn.select().from(schema.images).where(identity);
        if (existing[0]) {
            const row = existing[0];
            const backfill: Partial<NewImage> = {};
            if (!row.registry && data.registry) backfill.registry = data.registry;
            if (!row.repository && data.repository) backfill.repository = data.repository;
            // `lastSeenAt` is bumped unconditionally, backfill or not: an upload
            // for this digest is the evidence the GC ages on, and it is the only
            // evidence a cluster-free image ever gets. Skipping the write when
            // there is nothing to backfill would let a digest that is uploaded
            // daily but deployed nowhere age out and be collected.
            const now = new Date();
            const [updated] = await conn
                .update(schema.images)
                .set({ ...backfill, lastSeenAt: now, updatedAt: now })
                .where(eq(schema.images.id, row.id))
                .returning();
            return updated ?? row;
        }

        try {
            const [created] = await conn.insert(schema.images).values(data).returning();
            return created!;
        } catch (err) {
            if (isUniqueViolation(err)) {
                // The recovery lookup filters by cluster too — the same digest
                // in another cluster is a different image and never a winner.
                const [winner] = await conn
                    .select()
                    .from(schema.images)
                    .where(and(eq(schema.images.clusterId, data.clusterId), eq(schema.images.digest, data.digest)));
                if (winner) return winner;
            }
            throw err;
        }
    },

    /**
     * The org's images, each with its SBOM, findings and usage.
     *
     * This is the remediation view: one row per thing a user can actually
     * change, however many workloads share it. Scoped by `images.orgId`
     * directly (ADR 0006) rather than derived from `workload_containers`
     * usage — which also makes an uploaded-but-not-yet-inventoried image
     * appear with `containerCount: 0`, the correct post-upload state. The
     * same digest in N clusters is N rows, told apart by `clusterName`.
     */
    async findAllWithStats(orgId: string): Promise<ImageWithStats[]> {
        const imageRows = await db
            .select({
                image: schema.images,
                clusterName: schema.clusters.name,
            })
            .from(schema.images)
            .innerJoin(schema.clusters, eq(schema.images.clusterId, schema.clusters.id))
            .where(eq(schema.images.orgId, orgId));

        if (imageRows.length === 0) return [];
        const imageIds = imageRows.map((r) => r.image.id);

        const [usage, sbomRows, componentCounts, vulnByImage, riskByImage, lastMatchedByImage] = await Promise.all([
            db
                .select({
                    imageId: schema.workloadContainers.imageId,
                    containerCount: count(),
                    // Nulls (digest-pinned containers) are dropped in SQL: the
                    // driver hands a null array element back as the string
                    // "NULL", which no filter here can tell from a tag.
                    tags: sql<string[]>`array_remove(array_agg(DISTINCT ${schema.workloadContainers.imageTag}), NULL)`,
                    namespaces: sql<string[]>`array_agg(DISTINCT ${schema.namespaces.name})`,
                })
                .from(schema.workloadContainers)
                .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
                .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
                .where(
                    and(
                        eq(schema.workloadContainers.orgId, orgId),
                        inArray(schema.workloadContainers.imageId, imageIds),
                    ),
                )
                .groupBy(schema.workloadContainers.imageId),
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
            imageRiskScores(imageIds),
            latestScanCompletionByImage(imageIds),
        ]);

        const sbomByImage = new Map(sbomRows.map((s) => [s.imageId, s]));
        const componentCountByImage = new Map(componentCounts.map((c) => [c.imageId, c.componentCount]));
        const usageByImage = new Map(usage.map((u) => [u.imageId, u]));

        const scanned = await scannedImageIds(new Map(sbomRows.map((s) => [s.imageId, s.id])));

        return imageRows.map(({ image, clusterName }) => {
            const sbom = sbomByImage.get(image.id);
            const use = usageByImage.get(image.id);
            return {
                ...image,
                clusterName,
                sbomId: sbom?.id ?? null,
                scannedAt: sbom?.createdAt?.toISOString() ?? null,
                lastMatchedAt: lastMatchedByImage.get(image.id)?.toISOString() ?? null,
                componentCount: componentCountByImage.get(image.id) ?? 0,
                vulnerabilities: scanned.has(image.id) ? (vulnByImage.get(image.id) ?? emptySeverityCounts()) : null,
                containerCount: use?.containerCount ?? 0,
                tags: [...(use?.tags ?? [])].sort(),
                namespaces: [...(use?.namespaces ?? [])].sort(),
                // Same witness as `vulnerabilities`: null means nobody looked,
                // zero means we looked and found nothing.
                risk: scanned.has(image.id) ? (riskByImage.get(image.id) ?? emptyRiskRollup()) : null,
            };
        });
    },

    /**
     * Severity counts and risk for one image, or `null` when nothing has
     * scanned it. The per-image half of `findAllWithStats`; usage (`tags`,
     * `containerCount`) comes from `findDeployments`, which the detail route
     * fetches anyway.
     */
    async findStatsById(imageId: string): Promise<{
        sbomId: string | null;
        scannedAt: string | null;
        lastMatchedAt: string | null;
        componentCount: number;
        vulnerabilities: SeverityCounts | null;
        risk: RiskRollup | null;
    }> {
        const [sbom] = await db
            .select({ id: schema.sboms.id, createdAt: schema.sboms.createdAt })
            .from(schema.sboms)
            .where(eq(schema.sboms.imageId, imageId));

        if (!sbom) {
            return {
                sbomId: null,
                scannedAt: null,
                lastMatchedAt: null,
                componentCount: 0,
                vulnerabilities: null,
                risk: null,
            };
        }

        const [vulns, riskByImage, [componentRow], scanned, lastMatchedByImage] = await Promise.all([
            severityCountsForScope(eq(schema.images.id, imageId)),
            imageRiskScores([imageId]),
            db.select({ componentCount: count() }).from(schema.components).where(eq(schema.components.sbomId, sbom.id)),
            scannedImageIds(new Map([[imageId, sbom.id]])),
            latestScanCompletionByImage([imageId]),
        ]);

        return {
            sbomId: sbom.id,
            scannedAt: sbom.createdAt.toISOString(),
            lastMatchedAt: lastMatchedByImage.get(imageId)?.toISOString() ?? null,
            componentCount: componentRow?.componentCount ?? 0,
            vulnerabilities: scanned.has(imageId) ? vulns : null,
            risk: scanned.has(imageId) ? (riskByImage.get(imageId) ?? emptyRiskRollup()) : null,
        };
    },

    /**
     * Every place an image runs — the other half of the remediation question.
     * "Change `image:` from A to B" is one action; this is the list of files it
     * has to be applied to.
     */
    async findDeployments(imageId: string, orgId: string) {
        const h = schema.workloadContainerHistory;
        return (
            db
                .select({
                    /* Since when the container has run this digest — its open
                   history interval, as on the containers list. Null = no
                   interval recorded yet, never zero. */
                    onImageSince: h.startedAt,
                    onImageSinceIsLowerBound: sql<boolean>`coalesce((${h.startedAt} <= ${schema.clusters.firstInventoryAt} + interval '10 minutes') IS NOT FALSE AND ${h.id} IS NOT NULL, false)`,
                    containerId: schema.workloadContainers.id,
                    containerName: schema.workloadContainers.name,
                    init: schema.workloadContainers.init,
                    imageTag: schema.workloadContainers.imageTag,
                    imageRef: schema.workloadContainers.imageRef,
                    runningPods: schema.workloadContainers.runningPods,
                    workloadId: schema.workloads.id,
                    workloadName: schema.workloads.name,
                    workloadKind: schema.workloads.kind,
                    namespaceId: schema.namespaces.id,
                    namespaceName: schema.namespaces.name,
                    clusterId: schema.namespaces.clusterId,
                    releaseId: schema.workloads.releaseId,
                })
                .from(schema.workloadContainers)
                .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
                .innerJoin(schema.namespaces, eq(schema.workloads.namespaceId, schema.namespaces.id))
                .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
                .innerJoin(schema.clusters, eq(schema.namespaces.clusterId, schema.clusters.id))
                // At most one row: `wc_history_open_slot_unique` is on exactly these columns.
                .leftJoin(
                    h,
                    and(
                        eq(h.clusterId, schema.namespaces.clusterId),
                        eq(h.namespace, schema.namespaces.name),
                        eq(h.workloadName, schema.workloads.name),
                        eq(h.containerName, schema.workloadContainers.name),
                        eq(h.digest, schema.images.digest),
                        isNull(h.endedAt),
                    ),
                )
                .where(and(eq(schema.workloadContainers.imageId, imageId), eq(schema.workloadContainers.orgId, orgId)))
                .orderBy(schema.namespaces.name, schema.workloads.name, schema.workloadContainers.name)
        );
    },
};
