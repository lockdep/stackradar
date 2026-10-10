import { z } from "zod";

// ============================================================================
// Job Schemas
// ============================================================================

/**
 * Schema for job ID parameter.
 *
 * The only job schema left, deliberately: no request — tenant or admin —
 * may create a job. Scans are queued by the system (SBOM upload, the
 * post-sync fleet rescan in `osv-sync/rescan.ts`), and platform jobs are
 * enqueued by the worker under the system org.
 */
export const jobIdParamSchema = z.object({
    id: z.uuid("Invalid job ID"),
});
