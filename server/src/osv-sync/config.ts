/**
 * OSV Sync Configuration
 *
 * All configuration for the OSV vulnerability mirror sync process.
 * Values can be overridden via environment variables.
 */

import { envNumber, envString } from "../lib/env.js";
import { edition } from "../edition.js";
import { ECOSYSTEMS_ENV_VAR, parseEcosystems } from "./ecosystems.js";

export interface OsvSyncConfig {
    // Database
    databaseUrl: string;

    // OSV Data Sources
    osvAllZipUrl: string;
    osvModifiedCsvUrl: string;
    osvStorageBaseUrl: string;

    // Sync settings
    overlapWindowMinutes: number;

    // Performance
    maxParallelDownloads: number;
    batchSize: number;

    // Above this many candidates in one incremental run, per-record GETs are
    // abandoned for the per-ecosystem ZIP archives. A burst day is ~200x the
    // steady state, and tens of thousands of individual requests is the wrong
    // shape of work for it.
    bulkFallbackThreshold: number;

    // How broken a full rebuild may be and still be allowed to replace the live
    // mirror. A rebuild is rejected only when it exceeds *both*: a handful of
    // unparseable advisories is routine, a systemic failure is not.
    bootstrapMaxFailedEntries: number;
    bootstrapMaxFailedEntryRatio: number;

    // Health
    lagWarningThresholdHours: number;

    // How long parse/download failure rows are kept before a successful run
    // sweeps them. 0 disables the sweep.
    failureRetentionDays: number;

    // HTTP
    userAgent: string;
    requestTimeoutMs: number;
    /**
     * Applies to a streamed body rather than the whole request: abort when no
     * bytes have arrived for this long. A fixed overall deadline is useless for
     * a 1.35 GB download whose legitimate duration varies by an order of
     * magnitude; "nothing is arriving" is the condition worth acting on.
     */
    streamStallTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;

    // Advisory lock
    advisoryLockId: number;

    /**
     * The OSV directories the mirror carries, or `null` for the whole corpus
     * (`ecosystems.ts`). A scoped bootstrap pulls `<dir>/all.zip` per
     * ecosystem instead of the global `all.zip`, and the incremental sync
     * ignores `modified_id.csv` entries outside the scope.
     */
    ecosystems: string[] | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): OsvSyncConfig {
    return {
        // Database
        databaseUrl: envString(
            "DATABASE_URL",
            "postgres://postgres:postgres@localhost:5444/server"
        ),

        // OSV Data Sources
        osvAllZipUrl: envString(
            "OSV_ALL_ZIP_URL",
            "https://storage.googleapis.com/osv-vulnerabilities/all.zip"
        ),
        osvModifiedCsvUrl: envString(
            "OSV_MODIFIED_CSV_URL",
            "https://storage.googleapis.com/osv-vulnerabilities/modified_id.csv"
        ),
        osvStorageBaseUrl: envString(
            "OSV_STORAGE_BASE_URL",
            "https://storage.googleapis.com/osv-vulnerabilities"
        ),

        // Sync settings
        overlapWindowMinutes: envNumber("OSV_OVERLAP_WINDOW_MINUTES", 10),

        // Performance
        maxParallelDownloads: envNumber("OSV_MAX_PARALLEL_DOWNLOADS", 8),
        batchSize: envNumber("OSV_BATCH_SIZE", 100),
        bulkFallbackThreshold: envNumber("OSV_BULK_FALLBACK_THRESHOLD", 5000),
        bootstrapMaxFailedEntries: envNumber("OSV_BOOTSTRAP_MAX_FAILED_ENTRIES", 1000),
        bootstrapMaxFailedEntryRatio: envNumber("OSV_BOOTSTRAP_MAX_FAILED_ENTRY_RATIO", 0.005),

        // Health
        lagWarningThresholdHours: envNumber("OSV_LAG_WARNING_THRESHOLD_HOURS", 6),
        failureRetentionDays: envNumber("OSV_FAILURE_RETENTION_DAYS", 30),

        // HTTP
        userAgent: envString("OSV_USER_AGENT", "sbom-tracker-osv-sync/1.0"),
        requestTimeoutMs: envNumber("OSV_REQUEST_TIMEOUT_MS", 30_000), // 30 seconds
        streamStallTimeoutMs: envNumber("OSV_STREAM_STALL_TIMEOUT_MS", 60_000), // 60 seconds
        maxRetries: envNumber("OSV_MAX_RETRIES", 3),
        retryBaseDelayMs: envNumber("OSV_RETRY_BASE_DELAY_MS", 1000),

        // Advisory lock - unique identifier for pg_try_advisory_lock
        // Use a hash of "osv-sync" to generate a consistent lock ID
        advisoryLockId: envNumber("OSV_ADVISORY_LOCK_ID", 8675309), // Arbitrary constant

        // Unset follows the edition: the community list, or everything on
        // the cloud. `*` asks for everything explicitly.
        ecosystems: parseEcosystems(env[ECOSYSTEMS_ENV_VAR], edition),
    };
}
