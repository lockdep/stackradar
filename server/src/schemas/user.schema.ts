import { z } from "zod";

// ============================================================================
// User Schemas
// ============================================================================

/**
 * Schema for creating a new organization (user-initiated)
 */
export const createUserOrgSchema = z.object({
    name: z.string()
        .min(2, "Name must be at least 2 characters")
        .max(50, "Name must be at most 50 characters"),
});
