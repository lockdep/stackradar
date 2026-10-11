import { pgTable, text, timestamp, integer, boolean, jsonb, index, serial, real } from "drizzle-orm/pg-core";

/**
 * OSV Mirror Sync State Table
 *
 * Single-row table tracking the sync state of the OSV vulnerability mirror.
 * Uses a constant PK (id=1) to ensure only one row exists.
 */
export const osvSyncState = pgTable("osv_sync_state", {
    id: integer("id").primaryKey().default(1),

    // Whether the initial full import has been completed
    initialized: boolean("initialized").notNull().default(false),

    initCompletedAt: timestamp("init_completed_at", { withTimezone: true }),

    // When we last successfully polled modified_id.csv
    lastSuccessfulPollAt: timestamp("last_successful_poll_at", { withTimezone: true }),

    // Max modified timestamp observed in modified_id.csv (what OSV says exists)
    lastModifiedSeen: timestamp("last_modified_seen", { withTimezone: true }),

    // Max modified timestamp we've successfully applied to DB (our watermark)
    lastModifiedApplied: timestamp("last_modified_applied", { withTimezone: true }),

    // When we last completed a full refresh (re-import from all.zip)
    lastFullRefreshAt: timestamp("last_full_refresh_at", { withTimezone: true }),

    // Current sync status: "idle" | "full_refresh" | "incremental"
    syncStatus: text("sync_status").notNull().default("idle"),

    // Pointer to the live generation of vulnerability_affected_packages. A
    // bootstrap builds generation N+1 while readers keep serving N, then this
    // pointer and the deletion of the old rows move together in one
    // transaction. Readers resolve it through `isCurrentGeneration()`.
    affectedPkgGeneration: integer("affected_pkg_generation").notNull().default(1),

    // Count of consecutive failures (for exponential backoff)
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),

    // Last error message (null if last operation succeeded)
    lastError: text("last_error"),

    // The OSV directories the live generation was built from
    // (`OSV_ECOSYSTEMS`, osv-sync/ecosystems.ts), or null for the whole
    // corpus. Written by the bootstrap that published the generation, so it
    // describes what the mirror *contains*, which is not necessarily what
    // the process is currently configured to want: widening the scope
    // after a bootstrap changes nothing until `--bootstrap-if-needed`
    // notices the gap and rebuilds.
    ecosystems: jsonb("ecosystems").$type<string[]>(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * OSV Sync Failures Table
 *
 * Records individual parse or download failures encountered during OSV sync
 * runs. Each row corresponds to one OSV record that could not be processed.
 * Grouped by `syncRunId` so callers can inspect all failures for a given run.
 */
export const osvSyncFailures = pgTable(
    "osv_sync_failures",
    {
        id: serial("id").primaryKey(),

        // UUID generated at the start of each sync cycle
        syncRunId: text("sync_run_id").notNull(),

        // "initialization" | "incremental"
        syncMode: text("sync_mode").notNull(),

        // OSV vulnerability ID (null when JSON was unparseable)
        osvId: text("osv_id"),

        // Ecosystem directory from the path (null when unknown)
        ecosystemDir: text("ecosystem_dir"),

        // Original file path or zip entry path
        sourcePath: text("source_path").notNull(),

        // "parse_error" | "download_error"
        errorType: text("error_type").notNull(),

        errorMessage: text("error_message").notNull(),

        occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Composite index covers the natural "show all failures for run X
        // ordered by time" query. The leading `sync_run_id` column also
        // satisfies single-column lookups, so the standalone
        // `osv_sync_failures_run_id_idx` would be redundant. The
        // occurred-at-only index is kept for the cross-run "recent
        // failures" view.
        index("osv_sync_failures_run_occurred_idx").on(table.syncRunId, table.occurredAt),
        index("osv_sync_failures_occurred_at_idx").on(table.occurredAt),
    ],
);

/**
 * OSV Sync Runs Table
 *
 * Records one row per completed sync cycle (initialization or incremental).
 * Provides a queryable history of sync activity without needing to parse logs.
 */
export const osvSyncRuns = pgTable(
    "osv_sync_runs",
    {
        // UUID generated at the start of each sync cycle (matches osv_sync_failures.sync_run_id)
        id: text("id").primaryKey(),

        // "initialization" | "incremental"
        mode: text("mode").notNull(),

        // Whether the sync cycle completed without a fatal error
        success: boolean("success").notNull(),

        recordsProcessed: integer("records_processed").notNull().default(0),
        inserted: integer("inserted").notNull().default(0),
        updated: integer("updated").notNull().default(0),
        unchanged: integer("unchanged").notNull().default(0),
        affectedPackagesExtracted: integer("affected_packages_extracted").notNull().default(0),
        schemaValidationWarnings: integer("schema_validation_warnings").notNull().default(0),
        parseFailures: integer("parse_failures").notNull().default(0),
        deduplicatedCandidates: integer("deduplicated_candidates").notNull().default(0),

        durationMs: integer("duration_ms").notNull(),

        // Lag between OSV's latest record and our watermark (null for initialization)
        lagSeconds: real("lag_seconds"),

        // Top-level errors (fatal errors or download failures); null when none
        errors: jsonb("errors").$type<string[]>(),

        startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
        completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index("osv_sync_runs_completed_at_idx").on(table.completedAt),
        index("osv_sync_runs_mode_idx").on(table.mode),
    ],
);

export type OsvSyncRun = typeof osvSyncRuns.$inferSelect;
export type NewOsvSyncRun = typeof osvSyncRuns.$inferInsert;

export type SyncStatus = "idle" | "full_refresh" | "incremental";

export type OsvSyncState = typeof osvSyncState.$inferSelect;
export type NewOsvSyncState = typeof osvSyncState.$inferInsert;
export type OsvSyncStateUpdate = Partial<Omit<NewOsvSyncState, "id" | "createdAt">>;

export type OsvSyncFailure = typeof osvSyncFailures.$inferSelect;
export type NewOsvSyncFailure = typeof osvSyncFailures.$inferInsert;
