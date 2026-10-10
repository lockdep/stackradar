/**
 * Applying EPSS scores to the advisory mirror.
 *
 * ## Where the scores go, and a correction
 *
 * `README.md` in this directory and `docs/proposals/risk-ranking.md` both
 * describe writing to a table called `osv_vulns`. **There is no such table.**
 * `db/schema/osv-mirror.ts` holds only the sync's own bookkeeping
 * (`osv_sync_state`, `osv_sync_runs`, `osv_sync_failures`); the OSV mirror
 * writes advisories straight into `vulnerabilities` and their ranges into
 * `vulnerability_affected_packages`. So EPSS lands on `vulnerabilities`, which
 * is simpler than the design those documents assume — there is no propagation
 * step to a second table, and `vulnerabilities.risk_score` recomputes itself
 * the moment this UPDATE commits.
 *
 * ## Whole-file staging, not per-batch VALUES
 *
 * The README specifies ~440 `UPDATE … FROM (VALUES …)` statements, each
 * matching on `vuln_id = cve OR aliases @> cve`. That shape has two problems.
 * The `OR` denies the planner both indexes, so each statement degrades toward a
 * sequential scan of a 300k-row table — 440 of them. And a run that dies
 * half-way leaves the mirror carrying yesterday's scores for some advisories
 * and today's for others, with nothing recording which.
 *
 * Instead: stage the whole file into a temp table inside one transaction,
 * resolve both join paths against it, and apply a single UPDATE. Every join
 * becomes a hash join over a materialised set, the run is atomic, and the alias
 * path stops being the expensive one.
 *
 * ## Why the alias path exists at all
 *
 * EPSS is keyed by CVE. A large share of what the matcher actually finds is
 * not: `GHSA-…` for npm and Go, `PYSEC-…`, `RUSTSEC-…`, and distro advisories.
 * Most of those declare a CVE in `aliases`; distro tracker records
 * (`UBUNTU-CVE-…`, Debian's and Rocky's equivalents) declare it only under OSV
 * `upstream`, read here off `raw_data`. Skipping either join would
 * leave the ecosystems our customers care most about entirely unscored — which
 * under `UNSCORED_EXPLOITABILITY` means every npm finding ranks on CVSS alone
 * while every Debian finding ranks on measured exploitation. That is not a
 * coverage gap, it is a systematic bias between ecosystems.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { recordStateFailure, upsertState } from "../db/single-row-state.js";
import { epssSyncState } from "../db/schema/threat-intel.js";
import type { EpssRow } from "./parser.js";
import { EPSS_APPLY_LOCK_KEY } from "./config.js";
import { SyncLockHeldError } from "../lib/sync-lock.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("epss-sync:repository");

/** Thrown inside `apply`'s transaction; see `EpssRepository.apply`. */
export class ShortFeedError extends Error {
    constructor(readonly rows: number, readonly minimum: number) {
        super(
            `EPSS feed had ${rows} usable rows, below the ${minimum} floor — refusing to apply. ` +
                `A truncated file would blank the score on every CVE it omits.`
        );
        this.name = "ShortFeedError";
    }
}

export interface ApplyResult {
    rowsInFile: number;
    /** CVEs in the file that reached an advisory, directly or through an alias. */
    cvesMatched: number;
    /**
     * CVEs in the file that reached nothing. Expected to be tens of thousands
     * and not a fault: EPSS scores every CVE in the NVD, while the mirror holds
     * only those with an ecosystem or distro advisory. It is the *matched*
     * count collapsing that means the join broke.
     */
    cvesUnmatched: number;
    /**
     * Advisories whose EPSS columns this run actually wrote — the ones whose
     * score moved. Much smaller than `cvesMatched` on a normal day, and the
     * number to watch: zero against a fresh file means the UPDATE is not
     * landing.
     */
    advisoriesUpdated: number;
}

export interface EpssRepository {
    getState(): Promise<typeof epssSyncState.$inferSelect | undefined>;
    /**
     * Stage every row and apply in one transaction.
     *
     * `minRows` is enforced *inside* that transaction, after staging and before
     * the UPDATE, so a truncated feed rolls back instead of landing. It is
     * passed in rather than read from config here: the repository enforces the
     * floor, the caller owns what the floor is.
     */
    apply(
        rows: AsyncIterable<EpssRow[]>,
        opts: { batchSize: number; minRows: number }
    ): Promise<ApplyResult>;
    recordSuccess(state: {
        scoreDate: string | null;
        rowsInFile: number;
        rowsMatched: number;
        rowsUnmatched: number;
    }): Promise<void>;
    recordFailure(message: string): Promise<void>;
}

export function createEpssRepository(): EpssRepository {
    return {
        async getState() {
            const [row] = await db.select().from(epssSyncState).limit(1);
            return row;
        },

        async apply(batches, { batchSize, minRows }) {
            return db.transaction(async (tx) => {
                // The shared pool sends `statement_timeout` (120 s by default,
                // see `db/index.ts`) as a session parameter. That is the right
                // discipline for an API request and the wrong one here: the
                // join below reads the whole mirror three times and the UPDATE
                // rewrites ~560k advisories most days, because FIRST.org nudges
                // nearly every score daily. Both crossed 120 s on 2026-09-07,
                // when an OSV ingest doubled the mirror to ~1.9M rows, and the
                // sync then failed silently for a week. `SET LOCAL` lifts the
                // limit for this transaction only; the pod's Job deadline is
                // the real ceiling. The same pattern is in `kev-sync`.
                await tx.execute(sql`SET LOCAL statement_timeout = 0`);

                // One apply at a time across every process on this
                // database. Transaction-scoped, so it releases with the
                // commit or the rollback and can never be leaked; a second
                // replica of the monolith (`src/topology.ts`) that fires the
                // same cron minute finds it held and skips, which is the
                // result it would have got by waiting and then rewriting the
                // same rows.
                const [lock] = await tx.execute<{ locked: boolean }>(
                    sql`SELECT pg_try_advisory_xact_lock(${EPSS_APPLY_LOCK_KEY}) AS locked`
                );
                if (!lock?.locked) throw new SyncLockHeldError("EPSS");

                // `ON COMMIT DROP` rather than an explicit teardown: the temp
                // table cannot outlive the transaction even if this throws, and
                // a leaked one would silently poison the next run in the same
                // session.
                await tx.execute(sql`
                    CREATE TEMP TABLE epss_staging (
                        cve text PRIMARY KEY,
                        score real NOT NULL,
                        percentile real NOT NULL
                    ) ON COMMIT DROP
                `);

                let rowsInFile = 0;
                for await (const batch of batches) {
                    if (batch.length === 0) continue;
                    rowsInFile += batch.length;
                    await tx.execute(sql`
                        INSERT INTO epss_staging (cve, score, percentile)
                        VALUES ${sql.join(
                            batch.map((r) => sql`(${r.cve}, ${r.score}, ${r.percentile})`),
                            sql`, `
                        )}
                        -- The feed has never shipped a duplicate CVE, but a
                        -- primary key that can abort a 220k-row load over one
                        -- repeated line is not worth the strictness.
                        ON CONFLICT (cve) DO NOTHING
                    `);
                }

                log.info({ rowsInFile, batchSize }, "EPSS rows staged");

                // The floor, checked here because here is the last point at
                // which not applying is free. A gzip stream truncated mid-file
                // decompresses cleanly up to the cut, so the row count after
                // parsing is the only reliable signal — and every CVE missing
                // from a short file would have its score blanked, which is not
                // a neutral state: it drops those findings to
                // `UNSCORED_EXPLOITABILITY` and reorders the whole product's
                // priority list. Throwing rolls the transaction back and leaves
                // yesterday's scores in place, which is always the better of
                // the two available answers.
                if (rowsInFile < minRows) {
                    throw new ShortFeedError(rowsInFile, minRows);
                }

                // Both join paths, unioned, then reduced to one score per
                // advisory.
                //
                // `max` is doing real work in the second path: an advisory may
                // alias several CVEs, and there is no basis for picking one of
                // them, so it takes the most exploited. That is the safe
                // direction — an advisory that covers a CVE under active
                // exploitation is at least that urgent — and it is why this is
                // not the same question `normalizedCveIdentity` refuses to
                // answer in `lib/vulnerability-aliases.ts`. That one decides
                // whether two advisories are *one finding*, where a wrong
                // answer hides a vulnerability. This one decides how urgent one
                // advisory is, where the conservative answer is the higher
                // number.
                //
                // Taking `max` of score and of percentile independently is safe
                // because EPSS percentile is monotone non-decreasing in score
                // by construction, so both maxima come from the same CVE.
                await tx.execute(sql`
                    CREATE TEMP TABLE epss_hits ON COMMIT DROP AS
                    SELECT v.id AS vuln_pk, e.cve, e.score, e.percentile
                    FROM vulnerabilities v
                    JOIN epss_staging e ON e.cve = upper(v.vuln_id)
                    UNION ALL
                    SELECT v.id AS vuln_pk, e.cve, e.score, e.percentile
                    FROM vulnerabilities v
                    CROSS JOIN LATERAL jsonb_array_elements_text(
                        coalesce(v.aliases, '[]'::jsonb)
                    ) AS a(alias)
                    JOIN epss_staging e ON e.cve = upper(a.alias)
                    UNION ALL
                    SELECT v.id AS vuln_pk, e.cve, e.score, e.percentile
                    FROM vulnerabilities v
                    CROSS JOIN LATERAL jsonb_array_elements_text(
                        coalesce(v.raw_data->'upstream', '[]'::jsonb)
                    ) AS u(upstream)
                    JOIN epss_staging e ON e.cve = upper(u.upstream)
                `);

                const updated = await tx.execute<{ n: string }>(sql`
                    WITH resolved AS (
                        SELECT vuln_pk, max(score) AS score, max(percentile) AS percentile
                        FROM epss_hits GROUP BY vuln_pk
                    ), applied AS (
                        UPDATE vulnerabilities v
                        SET epss_score = r.score,
                            epss_percentile = r.percentile,
                            epss_updated_at = now(),
                            updated_at = now()
                        FROM resolved r
                        WHERE v.id = r.vuln_pk
                          -- Skip rows whose score has not moved. Most days that
                          -- is the large majority, and every skipped row is a
                          -- dead tuple not created and a generated column not
                          -- recomputed.
                          AND (v.epss_score IS DISTINCT FROM r.score
                            OR v.epss_percentile IS DISTINCT FROM r.percentile)
                        RETURNING 1
                    )
                    SELECT count(*)::text AS n FROM applied
                `);

                // How many CVEs in the file reached *something*. Counted off
                // `epss_hits` rather than by re-probing the mirror per staged
                // row: the anti-join phrasing of "unmatched" reads better and
                // runs 220k correlated subqueries, one per CVE, over a 300k-row
                // table. Subtracting from the file size is the same answer for
                // the price of a scan already paid for.
                const matched = await tx.execute<{ n: string }>(sql`
                    SELECT count(DISTINCT cve)::text AS n FROM epss_hits
                `);
                const cvesMatched = Number(matched[0]?.n ?? 0);

                return {
                    rowsInFile,
                    cvesMatched,
                    cvesUnmatched: rowsInFile - cvesMatched,
                    advisoriesUpdated: Number(updated[0]?.n ?? 0),
                };
            });
        },

        async recordSuccess(state) {
            await upsertState(epssSyncState, {
                lastSyncedAt: new Date(),
                lastScoreDate: state.scoreDate,
                rowsInFile: state.rowsInFile,
                rowsMatched: state.rowsMatched,
                rowsUnmatched: state.rowsUnmatched,
                lastError: null,
            });
        },

        async recordFailure(message) {
            await recordStateFailure(epssSyncState, message);
        },
    };
}
