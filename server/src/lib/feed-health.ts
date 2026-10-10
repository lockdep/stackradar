/**
 * Freshness of the two exploitation feeds.
 *
 * Not columns on `epss_sync_state` / `kev_sync_state`, and not in
 * `db/schema/` at all: freshness is a question about *now*, and a stored
 * boolean answers it as of the last write — which is precisely the moment a
 * feed is guaranteed fresh. It also keeps `db/schema/index.ts` exporting
 * nothing but tables, which `tests/setup/test-db.ts` relies on when it
 * enumerates `keyof typeof schema` to truncate them.
 */

/**
 * Whether a feed is fresh enough for the product to lean on it.
 *
 * Not a column: freshness is a question about *now*, and a stored boolean
 * answers it as of the last write. Exported here so the API and the admin panel
 * do not each invent a threshold.
 *
 * Two days rather than one. Both feeds publish daily and both syncs run daily,
 * so a single missed run is a schedule that slipped, not a broken pipeline;
 * alerting on it teaches people to ignore the alert.
 */
export const FEED_STALE_AFTER_HOURS = 48;

export function isFeedStale(lastSyncedAt: Date | null | undefined, now = new Date()): boolean {
    if (!lastSyncedAt) return true;
    return now.getTime() - lastSyncedAt.getTime() > FEED_STALE_AFTER_HOURS * 3600_000;
}
