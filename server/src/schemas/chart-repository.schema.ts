import { z } from "zod";

/**
 * Zod schemas for `/api/chart-repositories`.
 *
 * Two rules the shapes encode:
 *
 * - Only http(s) URLs. An index.yaml lives behind HTTP; OCI repositories are
 *   a different protocol and a fast-follow, so accepting `oci://` here would
 *   store a row nothing can refresh.
 * - `source` on creation is `manual` or `artifact-hub-confirmed`, never
 *   `observed` — observed rows are written by the sync from inventory
 *   evidence, not by a request claiming to be one.
 */

export const chartRepositoryIdParamSchema = z.object({
    id: z.guid("Invalid chart repository ID"),
});

const httpUrl = z
    .url("A chart repository must be an http(s) URL")
    .regex(/^https?:\/\//i, "A chart repository must be an http(s) URL")
    .max(2048);

export const createChartRepositorySchema = z.object({
    url: httpUrl,
    source: z.enum(["manual", "artifact-hub-confirmed"]).default("manual"),
    username: z.string().min(1).max(255).optional(),
    password: z.string().min(1).max(4096).optional(),
});

export const updateChartRepositorySchema = z
    .object({
        enabled: z.boolean().optional(),
        username: z.string().min(1).max(255).nullish(),
        password: z.string().min(1).max(4096).nullish(),
    })
    .refine((p) => p.enabled !== undefined || p.username !== undefined || p.password !== undefined, {
        message: "Nothing to update",
    });

export const discoverChartQuerySchema = z.object({
    chart: z.string().min(1).max(253),
});
