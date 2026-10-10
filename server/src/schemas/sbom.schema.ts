import { z } from "zod";

// ============================================================================
// SBOM Schemas
// ============================================================================

/**
 * Schema for SBOM ID parameter
 */
export const sbomIdParamSchema = z.object({
    id: z.uuid("Invalid SBOM ID"),
});

/**
 * Query for `GET /api/sboms/:id/document`. `download=1` asks for a
 * `Content-Disposition: attachment` so the browser saves the file instead of
 * rendering it; anything else (or nothing) serves it inline for viewing.
 */
export const sbomDocumentQuerySchema = z.object({
    download: z
        .string()
        .optional()
        .transform((v) => v === "1" || v === "true"),
});

/** A JSON object passed as a query-string value; malformed input is dropped. */
const jsonObjectParam = z
    .string()
    .optional()
    .transform((v) => {
        if (!v) return undefined;
        try {
            const parsed = JSON.parse(v);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
            return parsed as Record<string, string>;
        } catch {
            return undefined;
        }
    });

/**
 * Query parameters for `POST /v1/sboms/upload/cyclonedx`.
 *
 * **Image identity is the only required part of the query.** `imageDigest`
 * names the bytes the SBOM describes; the *cluster* half of image identity
 * comes from the API key, not the query — every upload requires a
 * cluster-scoped key under
 * [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md).
 *
 * Workload identity is **optional** and, when present, links the image to
 * where it runs. The link is a convenience for callers that already know it;
 * `POST /v1/inventory` is the primary write path for the workload side, and
 * it is the one that can express a mid-rollout Deployment honestly.
 *
 * Note there is no `labels` and no `isCurrent`. Pod labels are deployment
 * context and belong on the workload; `isCurrent` had nothing left to mean once
 * an image has exactly one SBOM.
 */
export const uploadSbomQuerySchema = z
    .object({
        // --- image identity (required) ---
        imageDigest: z.string().min(1).max(128),
        /**
         * Supersede this cluster's existing SBOM for the image instead of
         * answering 409. The recovery path for a bad scanner version or a
         * truncated document — safe under ADR 0006 because the replacement
         * can only affect the cluster whose key uploads it.
         */
        replace: z
            .string()
            .optional()
            .transform((v) => v === "true" || v === "1"),
        /** Verbatim `image:` from the pod spec, when the caller has it. */
        imageRef: z.string().min(1).max(2048).optional(),
        /** Derived from `imageRef` when omitted. */
        registry: z.string().min(1).max(255).optional(),
        repository: z.string().min(1).max(512).optional(),

        // --- workload identity (all optional; all-or-nothing, see below) ---
        namespace: z.string().min(1).max(253).optional(),
        workloadName: z.string().min(1).max(253).optional(),
        /** Omitted when the scanner could not resolve `ownerReferences`. */
        workloadKind: z.string().min(1).max(63).optional(),
        containerName: z.string().min(1).max(253).optional(),
        /**
         * The tag the deployment asked for. Omitted for a digest-pinned
         * deployment — there is no tag, and inventing `"latest"` labels every
         * distinct image identically. Stored on the container, not the image.
         */
        tag: z.string().min(1).max(255).optional(),
        namespaceLabels: jsonObjectParam,
        workloadLabels: jsonObjectParam,
    })
    .refine(
        (d) =>
            // Either no workload identity at all, or enough of it to name a
            // container. A half-specified workload would silently create a row
            // under a placeholder name, and placeholders outlive the request
            // that made them.
            (!d.namespace && !d.workloadName && !d.containerName) ||
            Boolean(d.namespace && d.workloadName && d.containerName),
        {
            message:
                "Workload identity requires namespace, workloadName and containerName together (or omit all three for an image-only ingest)",
        }
    )
    .transform(({ tag, ...rest }) => ({ ...rest, imageTag: tag }));

/** `GET /v1/sboms/check` — digest only. See `sbomRepository.existsByDigest`. */
export const checkSbomQuerySchema = z.object({
    imageDigest: z.string().min(1).max(128),
});
