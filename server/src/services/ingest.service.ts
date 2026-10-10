import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import { imageRepository } from "../repositories/image.repository.js";
import { parseImageRef } from "../utils/image-ref.js";
import type { Image } from "../db/schema/images.js";

export interface ImageIdentityInput {
    /** The cluster whose key made the upload — part of image identity now. */
    orgId: string;
    clusterId: string;
    imageDigest: string;
    imageRef?: string | undefined;
    registry?: string | undefined;
    repository?: string | undefined;
}

export interface WorkloadIdentityInput {
    orgId: string;
    clusterId: string;
    namespace: string;
    workloadName: string;
    workloadKind?: string | undefined;
    containerName: string;
    imageTag?: string | undefined;
    imageRef: string;
    namespaceLabels?: Record<string, string> | undefined;
    workloadLabels?: Record<string, string> | undefined;
}

/**
 * Resolving the two identities an upload carries.
 *
 * They are still separate, but both are cluster-scoped now (ADR 0006): the
 * image identity says *what this cluster scanned* and is required — an image
 * is `(clusterId, digest)`, so there is no cluster-free ingest any more — and
 * the workload identity says *where it runs* and stays optional, because an
 * upload can legitimately land before the inventory report that deploys it.
 */
export const ingestService = {
    /**
     * Find or create the `images` row an SBOM belongs to.
     *
     * `registry` and `repository` are parsed out of `imageRef` when it yields
     * them, falling back to the caller-supplied fields otherwise. The ref is
     * authoritative — it comes from the runtime's `imageID` and always names
     * the real repository — while the explicit fields are parsed by the
     * scanner from a *display* name, which for a digest-pinned pod is a bare
     * config hash: old agents sent `repository: 'sha256'` from exactly that.
     */
    async resolveImage(input: ImageIdentityInput): Promise<Image> {
        const parsed = input.imageRef ? parseImageRef(input.imageRef) : undefined;
        return imageRepository.findOrCreateByDigest({
            orgId: input.orgId,
            clusterId: input.clusterId,
            digest: input.imageDigest,
            registry: parsed?.registry ?? input.registry ?? null,
            // `||`: a bare image ID (`sha256:…`) parses to an empty
            // repository, and an empty string is not a name — it must not
            // shadow an explicit repository, nor land in the row.
            repository: (parsed?.repository || input.repository) ?? null,
        });
    },

    /**
     * Link an image to the container running it, creating the namespace and
     * workload on the way if this is the first time we have seen them.
     *
     * Written as one transaction of find-or-create steps rather than as a set
     * replacement: an upload knows about exactly one container and must not
     * imply anything about the rest of the cluster. `POST /v1/inventory` is the
     * endpoint that owns "everything running"; this one only ever adds.
     *
     * Idempotent — re-uploading the same image for the same container bumps
     * `lastSeenAt` and nothing else.
     */
    async linkWorkloadContainer(imageId: string, w: WorkloadIdentityInput): Promise<string> {
        const seenAt = new Date();

        return db.transaction(async (tx) => {
            const [ns] = await tx
                .insert(schema.namespaces)
                .values({
                    orgId: w.orgId,
                    clusterId: w.clusterId,
                    name: w.namespace,
                    labels: w.namespaceLabels ?? null,
                    firstSeenAt: seenAt,
                    lastSeenAt: seenAt,
                })
                .onConflictDoUpdate({
                    target: [schema.namespaces.clusterId, schema.namespaces.name],
                    set: {
                        // Only when the upload actually carries labels. Unlike
                        // the inventory path, an upload is not authoritative
                        // about namespace metadata, so it must not clear what
                        // an inventory report established.
                        labels: sql`coalesce(excluded.labels, ${schema.namespaces.labels})`,
                        lastSeenAt: seenAt,
                        updatedAt: seenAt,
                    },
                })
                .returning({ id: schema.namespaces.id });

            const namespaceId = ns!.id;
            const kind = w.workloadKind ?? null;

            const workloadValues = {
                orgId: w.orgId,
                namespaceId,
                kind,
                name: w.workloadName,
                labels: w.workloadLabels ?? null,
                firstSeenAt: seenAt,
                lastSeenAt: seenAt,
            };
            const workloadSet = {
                labels: sql`coalesce(excluded.labels, ${schema.workloads.labels})`,
                lastSeenAt: seenAt,
                updatedAt: seenAt,
            };

            // Two arbiters, because `workloads` carries two partial unique
            // indexes — see the table definition for why NULL kinds need their
            // own. `ON CONFLICT` names exactly one index, so the branch is here.
            const [workload] = kind === null
                ? await tx
                    .insert(schema.workloads)
                    .values(workloadValues)
                    .onConflictDoUpdate({
                        target: [schema.workloads.namespaceId, schema.workloads.name],
                        targetWhere: sql`kind IS NULL`,
                        set: workloadSet,
                    })
                    .returning({ id: schema.workloads.id })
                : await tx
                    .insert(schema.workloads)
                    .values(workloadValues)
                    .onConflictDoUpdate({
                        target: [schema.workloads.namespaceId, schema.workloads.kind, schema.workloads.name],
                        targetWhere: sql`kind IS NOT NULL`,
                        set: workloadSet,
                    })
                    .returning({ id: schema.workloads.id });

            const [container] = await tx
                .insert(schema.workloadContainers)
                .values({
                    orgId: w.orgId,
                    workloadId: workload!.id,
                    name: w.containerName,
                    imageId,
                    imageRef: w.imageRef,
                    imageTag: w.imageTag ?? null,
                    firstSeenAt: seenAt,
                    lastSeenAt: seenAt,
                })
                .onConflictDoUpdate({
                    target: [
                        schema.workloadContainers.workloadId,
                        schema.workloadContainers.name,
                        schema.workloadContainers.imageId,
                    ],
                    set: {
                        imageRef: sql`excluded.image_ref`,
                        imageTag: sql`excluded.image_tag`,
                        lastSeenAt: seenAt,
                        updatedAt: seenAt,
                    },
                })
                .returning({ id: schema.workloadContainers.id });

            return container!.id;
        });
    },

};
