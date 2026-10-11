import { z } from "zod";

/** Zod schemas shared across controllers (ids, pagination). */

/**
 * UUID parameter schema for route params
 * Used for validating entity IDs in URL parameters
 */
export const uuidParamSchema = z.object({
    id: z.uuid("Invalid ID format"),
});
