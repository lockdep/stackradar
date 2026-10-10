/**
 * KEV sync configuration.
 *
 * CISA publishes the Known Exploited Vulnerabilities catalogue as a single
 * unauthenticated JSON file of ~1,400 entries — under a megabyte, no paging, no
 * incremental format. So there is nothing here to tune but the URL and the
 * retry behaviour.
 */

import { envNumber, envString } from "../lib/env.js";

/**
 * `pg_try_advisory_xact_lock` key for the apply transaction; see
 * `EPSS_APPLY_LOCK_KEY` in `epss-sync/config.ts` for why. Distinct from it,
 * from the OSV sync's session lock and from the migration lock.
 */
export const KEV_APPLY_LOCK_KEY = 8675311;

export interface KevSyncConfig {
    databaseUrl: string;

    /** CISA's catalogue, refreshed on weekdays. */
    feedUrl: string;

    /** Skip if the last successful run was within this window. 0 forces. */
    minSyncIntervalHours: number;

    /**
     * Refuse a catalogue smaller than this.
     *
     * The same guard as the EPSS floor and for a sharper reason: this sync is a
     * **full replacement**, so a truncated file does not merely fail to add
     * entries — it actively clears `kev_listed_at` on every CVE it omits, which
     * silently demotes the highest-signal findings in the product. The
     * catalogue passed 1,000 entries in 2023 and only grows; 500 is a floor no
     * healthy file approaches.
     */
    minEntriesToApply: number;

    userAgent: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
}

export function loadConfig(): KevSyncConfig {
    return {
        databaseUrl: envString(
            "DATABASE_URL",
            "postgres://postgres:postgres@localhost:5444/server"
        ),
        feedUrl: envString(
            "KEV_FEED_URL",
            "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json"
        ),
        minSyncIntervalHours: envNumber("KEV_MIN_SYNC_INTERVAL_HOURS", 23),
        minEntriesToApply: envNumber("KEV_MIN_ENTRIES_TO_APPLY", 500),
        userAgent: envString("KEV_USER_AGENT", "sbom-tracker-kev-sync/1.0"),
        requestTimeoutMs: envNumber("KEV_REQUEST_TIMEOUT_MS", 30_000),
        maxRetries: envNumber("KEV_MAX_RETRIES", 3),
        retryBaseDelayMs: envNumber("KEV_RETRY_BASE_DELAY_MS", 2_000),
    };
}
