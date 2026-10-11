import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "./organizations.js";
import { images } from "./images.js";
import { sboms } from "./sboms.js";

/**
 * Job Status:
 * - "pending": Job is queued, waiting to be picked up
 * - "scheduled": Job is scheduled for a future time
 * - "processing": Job is currently being executed
 * - "completed": Job finished successfully
 * - "failed": Job failed with an error
 * - "cancelled": Job was cancelled before completion
 */
export type JobStatus = "pending" | "scheduled" | "processing" | "completed" | "failed" | "cancelled";

/**
 * Job Types:
 * - "vulnerability_scan": Scan an image's components for vulnerabilities
 * - "full_sync": Full vulnerability sync across all components
 * - "scheduled_scan": Recurring scheduled vulnerability scan
 * - "chart_render": Render a candidate chart version and record the images it
 *   deploys. Runs under the platform
 *   org; params carry `{ repoUrl, chartName, chartVersion, tarballUrl }` and
 *   no tenant data.
 * - "platform_scan": Pull a public candidate digest, run syft, and ingest the
 *   SBOM under the platform cluster.
 *   Params carry `{ digest, registry, repository }`.
 * - "chart_repo_refresh": Fetch and parse one chart repository's index.yaml
 *   on behalf of the settings page's Refresh button. Off the request path
 *   because the URL is user-supplied and the parse is synchronous: a hostile
 *   or slow index would otherwise stall every tenant's requests, so the
 *   request only enqueues and the worker's size and parse budgets bound the
 *   work. Params carry `{ repositoryId }`.
 */
export type JobType =
    | "vulnerability_scan"
    | "full_sync"
    | "scheduled_scan"
    | "chart_render"
    | "platform_scan"
    | "chart_repo_refresh"
    /**
     * Re-run the component classifier over one org's components after its
     * tier rules changed (`services/tier-rules.service.ts`). Off the request
     * path: an org can hold hundreds of thousands of components.
     */
    | "tier_reclassify";

/**
 * What triggered the job:
 * - "manual": User-initiated via the UI or API
 * - "sbom_upload": Automatically triggered after a new SBOM upload
 * - "schedule": Triggered by a scheduled/recurring scan
 * - "system": System-initiated (e.g. full sync, maintenance)
 */
export type JobTrigger = "manual" | "sbom_upload" | "schedule" | "system";

/**
 * Jobs table
 * Tracks background jobs for SBOM processing, vulnerability scanning, etc.
 */
export const jobs = pgTable(
    "jobs",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),

        // Optional image association (some jobs are org-wide). A scan job is about
        // an image, not a workload: the same image in five namespaces is one scan.
        imageId: uuid("image_id").references(() => images.id, { onDelete: "cascade" }),

        // Optional SBOM target (pins scan jobs to a specific SBOM version)
        sbomId: uuid("sbom_id").references(() => sboms.id, { onDelete: "cascade" }),

        type: varchar("type", { length: 50 }).notNull().$type<JobType>(),
        status: varchar("status", { length: 20 }).notNull().default("pending").$type<JobStatus>(),

        // Job priority (higher = more urgent, default 0)
        priority: integer("priority").notNull().default(0),

        title: varchar("title", { length: 255 }).notNull(),

        triggeredBy: varchar("triggered_by", { length: 20 }).notNull().default("manual").$type<JobTrigger>(),

        scheduledFor: timestamp("scheduled_for", { withTimezone: true }),

        startedAt: timestamp("started_at", { withTimezone: true }),
        completedAt: timestamp("completed_at", { withTimezone: true }),

        // Progress tracking (0-100)
        progress: integer("progress").default(0),
        // Stored as text so truncated stack traces / long status messages are
        // never silently cut off.
        progressMessage: text("progress_message"),

        params: jsonb("params").$type<Record<string, unknown>>(),

        result: jsonb("result").$type<Record<string, unknown>>(),

        // Error info on failure. `errorCode` is `text` to fit Node error class
        // names (which can chain — e.g. `ECONNREFUSED_ENOTFOUND_RESOLVE`).
        errorCode: text("error_code"),
        errorMessage: text("error_message"),

        retryCount: integer("retry_count").notNull().default(0),
        maxRetries: integer("max_retries").notNull().default(3),

        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Hot queue path: claimNextJobs polls every few seconds with
        // (status IN ('pending','scheduled')) ORDER BY priority DESC, created_at ASC.
        // Partial index keeps the index small (excludes terminal-state rows) and
        // the per-column sort order (`priority DESC, created_at ASC`) matches the
        // claim query's mixed-direction ORDER BY — a plain (priority, created_at)
        // btree cannot serve DESC/ASC mixed ordering.
        index("jobs_queue_idx")
            .on(table.priority.desc(), table.createdAt.asc())
            .where(sql`${table.status} IN ('pending', 'scheduled')`),
        // Cleanup + recent-jobs listings filter on terminal statuses + completed_at.
        index("jobs_completed_at_idx")
            .on(table.completedAt)
            .where(sql`${table.status} IN ('completed', 'failed', 'cancelled')`),
        // Scheduled-for index restricted to the only rows it can match.
        index("jobs_scheduled_for_idx")
            .on(table.scheduledFor)
            .where(sql`${table.status} = 'scheduled'`),
        // Index for organization-specific job queries (non-terminal listings)
        index("jobs_org_id_idx").on(table.orgId),
        // Image-specific job queries: covers findLatestVulnScanForImage(imageId)
        // and findAll({ imageId }).
        index("jobs_image_id_type_created_idx").on(table.imageId, table.type, table.createdAt),
        // Covers FK cascades from sboms and sbom-scoped job lookups
        index("jobs_sbom_id_idx").on(table.sbomId),
        // All three partial indexes above key on status literals, so a typo'd
        // status would make a job invisible to both the queue and cleanup.
        // Constrain to the JobStatus union.
        check(
            "jobs_status_check",
            sql`${table.status} IN ('pending', 'scheduled', 'processing', 'completed', 'failed', 'cancelled')`,
        ),
    ],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
