import { z } from "zod";

/** Zod schemas for `/api/search`, the global palette. */

/**
 * `GET /api/search?q=<term>&limit=<n>` — the global palette's one request.
 *
 * `q` is trimmed before the length check so a pasted id with a trailing
 * space still searches; two characters is the floor because a one-character
 * `ILIKE '%x%'` matches most of an org. `limit` is per result group.
 */
export const searchQuerySchema = z.object({
    q: z.string().trim().min(2, "q must be at least 2 characters").max(200),
    limit: z.coerce.number().int().min(1).max(10).default(5),
    /** The tier lens — see `tierQueryField` in `cluster.schema.ts`. */
    tier: z.string().max(100).optional(),
});
