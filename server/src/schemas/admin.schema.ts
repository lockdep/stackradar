import { z } from "zod";

/**
 * Zod schemas for `/api/admin`.
 *
 * Query values degrade rather than 400 where the old hand-parsing did: an
 * admin URL with a mangled `limit` or an unrecognised `state` falls back to
 * the default instead of erroring, so a typo cannot produce an empty screen
 * that looks like an empty database. Route params are different — a non-UUID
 * id is answered with a 400 instead of leaking a Postgres cast error as 500.
 */

/** `?limit=` / `?offset=` for the admin tables, clamped to [1, 200]. */
export const adminListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).catch(50).default(50),
    offset: z.coerce.number().int().min(0).catch(0).default(0),
});

/** `?status=` for the jobs table — one value or repeated, normalised to an array. */
export const adminJobsQuerySchema = adminListQuerySchema.extend({
    status: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .transform((s) => (s === undefined ? undefined : Array.isArray(s) ? s : [s])),
});

export const adminImagesQuerySchema = adminListQuerySchema.extend({
    state: z.enum(["orphaned", "awaiting_sbom", "scanned"]).optional().catch(undefined),
    sort: z.enum(["lastSeen", "firstSeen", "repository"]).optional().catch(undefined),
    search: z
        .string()
        .optional()
        .transform((s) => {
            const trimmed = s?.trim();
            return trimmed ? trimmed : undefined;
        }),
});

export const explorerImagesQuerySchema = z.object({
    orgId: z.uuid("orgId is required"),
});

export const explorerSbomsQuerySchema = z.object({
    imageId: z.uuid("imageId is required"),
});

export const explorerComponentsQuerySchema = adminListQuerySchema.extend({
    sbomId: z.uuid("sbomId is required"),
    search: z.string().optional(),
});

/** The `:orgId` route param on the per-org admin drill-downs. */
export const adminOrgIdParamSchema = z.object({
    orgId: z.uuid("Invalid organization ID"),
});

/** The `:componentId` route param on the explorer component detail. */
export const adminComponentIdParamSchema = z.object({
    componentId: z.uuid("Invalid component ID"),
});

/** The `:id` of an OSV parse failure — a serial row id, not a UUID. */
export const parseFailureIdParamSchema = z.object({
    id: z.coerce.number("Invalid id").int("Invalid id").positive("Invalid id"),
});
