import { z } from "zod";

/**
 * Zod schemas for the container, namespace, image and release routes.
 *
 * Replaces `project.schema.ts`. There is no `type: "project" | "group"` any
 * more: a namespace is a namespace, a workload is a workload, and the
 * vocabulary is Kubernetes'.
 */

/** A `workload_containers` row id — the unit the workload detail page renders. */
export const workloadIdParamSchema = z.object({
    id: z.guid("Invalid workload container ID"),
});

export const imageIdParamSchema = z.object({
    id: z.guid("Invalid image ID"),
});

export const releaseIdParamSchema = z.object({
    id: z.guid("Invalid release ID"),
});

/**
 * The four lenses over one set of rows — namespace (the folder view), chart
 * (what packaged it), app (what delivers it) and image (the remediation view).
 * Grouping is a read-time choice, not a storage hierarchy, so it arrives as a
 * filter rather than as a different endpoint.
 *
 * `releaseId` and `applicationId` are independent filters, not alternatives: a
 * workload commonly has both, and "everything this Argo app delivers from this
 * chart" is a legitimate intersection.
 */
export const workloadListQuerySchema = z.object({
    clusterId: z.guid("Invalid cluster ID").optional(),
    namespaceId: z.guid("Invalid namespace ID").optional(),
    releaseId: z.guid("Invalid release ID").optional(),
    applicationId: z.guid("Invalid application ID").optional(),
    imageId: z.guid("Invalid image ID").optional(),
});

export const clusterScopeQuerySchema = z.object({
    clusterId: z.guid("Invalid cluster ID").optional(),
});
