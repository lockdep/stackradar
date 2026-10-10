/**
 * Artifact Hub sync configuration.
 *
 * Same env-override shape as `epss-sync/config.ts`. One difference: this sync
 * carries an advisory lock (`advisoryLockId`). The EPSS sync could skip one
 * because a concurrent second run computes the same idempotent UPDATE; here the
 * stamp-and-prune delete is *not* idempotent under interleaving — a run pruning
 * on an older stamp while another has just upserted with a newer one would
 * delete live rows — and the sync runs both as a worker cron and as a CLI, so
 * overlap is a real possibility rather than a scheduling accident.
 */

import { envNumber, envString } from "../lib/env.js";

export interface ArtifactHubSyncConfig {
    databaseUrl: string;

    /**
     * The official bulk dump — one JSON array of every Helm package Artifact
     * Hub indexes, created so bulk consumers (Fairwinds Nova, Harbor) would
     * stop scraping the search API. CDN-cached with `max-age=7200`, no ETag.
     * `file://` URLs are supported for local runs — see `downloader.ts`.
     */
    feedUrl: string;

    /**
     * Skip the run if the last successful one finished within this window.
     * The dump's CDN cache is two hours, but the consumers here (nightly
     * attribution, nightly index sync) move daily, so re-fetching sooner
     * re-downloads 25 MB for nothing.
     */
    minSyncIntervalHours: number;

    /**
     * Refuse to apply a dump with fewer packages than this.
     *
     * The stamp-and-prune write deletes every row a sync did not mention, so a
     * valid-but-truncated CDN response would silently shrink the mirror and
     * cascade attributions with it. The dump has held ~18k packages; 10k is a
     * floor no healthy response approaches.
     */
    minPackagesToApply: number;

    /**
     * Byte ceiling on the response body. The dump is ~25 MB and the worker pod
     * has a 512Mi limit; if the dump ever quadruples, failing loudly here is
     * the right outcome and switching this module to a streaming JSON parser
     * is the documented escape hatch (see README).
     */
    maxBodyBytes: number;

    /** Rows per mirror upsert statement. */
    stagingBatchSize: number;

    /**
     * `pg_try_advisory_lock` key guarding cron-vs-CLI overlap.
     * Same numbering neighbourhood as `OSV_ADVISORY_LOCK_ID` (8675309).
     */
    advisoryLockId: number;

    userAgent: string;
    requestTimeoutMs: number;
    maxRetries: number;
    retryBaseDelayMs: number;
}

export function loadConfig(): ArtifactHubSyncConfig {
    return {
        databaseUrl: envString(
            "DATABASE_URL",
            "postgres://postgres:postgres@localhost:5444/server"
        ),
        feedUrl: envString("ARTIFACT_HUB_FEED_URL", "https://artifacthub.io/api/v1/nova"),
        minSyncIntervalHours: envNumber("ARTIFACT_HUB_MIN_SYNC_INTERVAL_HOURS", 23),
        minPackagesToApply: envNumber("ARTIFACT_HUB_MIN_PACKAGES_TO_APPLY", 10_000),
        maxBodyBytes: envNumber("ARTIFACT_HUB_MAX_BODY_BYTES", 100 * 1024 * 1024),
        stagingBatchSize: envNumber("ARTIFACT_HUB_STAGING_BATCH_SIZE", 500),
        advisoryLockId: envNumber("ARTIFACT_HUB_ADVISORY_LOCK_ID", 8_675_310),
        userAgent: envString("ARTIFACT_HUB_USER_AGENT", "sbom-tracker-artifacthub-sync/1.0"),
        requestTimeoutMs: envNumber("ARTIFACT_HUB_REQUEST_TIMEOUT_MS", 120_000),
        maxRetries: envNumber("ARTIFACT_HUB_MAX_RETRIES", 3),
        retryBaseDelayMs: envNumber("ARTIFACT_HUB_RETRY_BASE_DELAY_MS", 2_000),
    };
}
