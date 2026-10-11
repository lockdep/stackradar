/**
 * EPSS sync configuration.
 *
 * Same env-override shape as `osv-sync/config.ts`, and deliberately much
 * smaller: this sync downloads one 3 MB file and runs three statements, so
 * there is no parallelism to tune and no generation to point at. The one
 * piece of coordination is a transaction-scoped advisory lock on the apply
 * (`repository.ts`): two runs would compute the same UPDATE, but each
 * rewrites ~560k rows, and two monolith replicas starting the daily sync at
 * the same minute would otherwise both pay for it.
 */

import { envNumber, envString } from "../lib/env.js";
import { SERVER_VERSION } from "../lib/server-version.js";

/**
 * `pg_try_advisory_xact_lock` key for the apply transaction. Arbitrary, and
 * distinct from the OSV sync's session lock (`osv-sync/config.ts`, 8675309),
 * the KEV sync's (`kev-sync/config.ts`) and the migration lock
 * (`db/migrate.ts`).
 */
export const EPSS_APPLY_LOCK_KEY = 8675310;

export interface EpssSyncConfig {
    databaseUrl: string;

    /** FIRST.org's current-scores snapshot, gzipped CSV, refreshed daily ~00:00 UTC. */
    feedUrl: string;

    /**
     * Rows per INSERT into the staging table. Larger than the OSV sync's batch
     * because the rows are three scalars rather than a JSON document, and the
     * whole file is ~220k of them.
     */
    stagingBatchSize: number;

    /**
     * Skip the run if the last successful one finished within this window.
     * FIRST.org publishes once a day, so re-running sooner re-downloads 3 MB to
     * write the same numbers. Set to 0 to force.
     */
    minSyncIntervalHours: number;

    /**
     * Refuse to apply a file with fewer rows than this.
     *
     * A truncated download that still parses is the failure mode that matters
     * here: it would blank the EPSS score on every CVE it omits, and a null
     * score is not neutral — it drops those findings to
     * `UNSCORED_EXPLOITABILITY` and reorders the entire product's priority
     * list. The corpus has been above 200k since 2023, so 150k is a floor no
     * healthy file approaches.
     */
    minRowsToApply: number;

    userAgent: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
}

export function loadConfig(): EpssSyncConfig {
    return {
        databaseUrl: envString("DATABASE_URL", "postgres://postgres:postgres@localhost:5444/server"),
        feedUrl: envString("EPSS_FEED_URL", "https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
        stagingBatchSize: envNumber("EPSS_STAGING_BATCH_SIZE", 5_000),
        minSyncIntervalHours: envNumber("EPSS_MIN_SYNC_INTERVAL_HOURS", 23),
        minRowsToApply: envNumber("EPSS_MIN_ROWS_TO_APPLY", 150_000),
        userAgent: envString("EPSS_USER_AGENT", `stackradar-epss-sync/${SERVER_VERSION}`),
        requestTimeoutMs: envNumber("EPSS_REQUEST_TIMEOUT_MS", 60_000),
        maxRetries: envNumber("EPSS_MAX_RETRIES", 3),
        retryBaseDelayMs: envNumber("EPSS_RETRY_BASE_DELAY_MS", 2_000),
    };
}
