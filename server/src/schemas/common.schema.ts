import { z } from "zod";

// ============================================================================
// Common Schemas - Reusable validation schemas used across multiple controllers
// ============================================================================

/**
 * UUID parameter schema for route params
 * Used for validating entity IDs in URL parameters
 */
export const uuidParamSchema = z.object({
    id: z.uuid("Invalid ID format"),
});

