import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * State for the two exploitation feeds that decorate `vulnerabilities`.
 *
 * Separate from `osv-mirror.ts` because these are a different kind of sync.
 * The OSV mirror *owns* rows — it inserts advisories, and a failed bootstrap
 * can leave the matcher with nothing to match against, which is why it carries
 * generations, an advisory lock and a per-record failure table. EPSS and KEV
 * only ever `UPDATE` columns on advisories the mirror already wrote. A failed
 * run leaves yesterday's scores in place and the product working slightly less
 * well, so the machinery is correspondingly smaller: one state row each, no
 * generations, no failure log.
 *
 * Both are single-row tables on a constant PK, the same shape as
 * `osv_sync_state`.
 */

/**
 * EPSS sync state — one row, `id = 1`.
 *
 * The unmatched count is the interesting one and is expected to be large and
 * non-zero: EPSS scores every CVE in the NVD, and the OSV mirror holds only
 * those with an ecosystem advisory. A *matched* count that collapses, on the
 * other hand, means the join broke.
 */
export const epssSyncState = pgTable("epss_sync_state", {
    id: integer("id").primaryKey().default(1),

    /** Completion of the last successful run — what the 23-hour guard reads. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

    /**
     * `score_date` from the CSV's comment header, e.g. `2026-08-15`.
     *
     * The age the *data* claims, as distinct from `lastSyncedAt`, which is when
     * we fetched it. A sync that succeeds every night against a feed frozen a
     * fortnight ago is a healthy-looking pipeline serving stale predictions,
     * and this column is the only place that shows up.
     */
    lastScoreDate: text("last_score_date"),

    rowsInFile: integer("rows_in_file"),
    /** CVEs in the file that reached an advisory, directly or through an alias. */
    rowsMatched: integer("rows_matched"),
    /** CVEs in the file with no advisory in the mirror. Expected to be tens of thousands. */
    rowsUnmatched: integer("rows_unmatched"),

    /** Null when the last run succeeded. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * KEV sync state — one row, `id = 1`.
 *
 * `catalogVersion` and `releasedAt` come from the feed's own header and serve
 * the same staleness purpose as `epss_sync_state.last_score_date`.
 */
export const kevSyncState = pgTable("kev_sync_state", {
    id: integer("id").primaryKey().default(1),

    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

    /** CISA's `catalogVersion`, e.g. `2026.08.15`. */
    catalogVersion: text("catalog_version"),
    /** CISA's `dateReleased` for that catalogue version. */
    releasedAt: timestamp("released_at", { withTimezone: true }),

    /** `count` as declared by the feed, checked against what we parsed. */
    entriesInCatalog: integer("entries_in_catalog"),
    /** Entries that reached an advisory, directly or through an alias. */
    entriesMatched: integer("entries_matched"),

    /**
     * Advisories whose KEV columns this run cleared because CISA has removed
     * the CVE from the catalogue.
     *
     * Withdrawal is rare but real, and it has to propagate: a stale
     * `kev_listed_at` pins `exploitability` at 1.0 forever, which is the
     * single most influential input in the model. The run is a full
     * replacement for exactly this reason — see `kev-sync/repository.ts`.
     */
    entriesCleared: integer("entries_cleared"),

    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
