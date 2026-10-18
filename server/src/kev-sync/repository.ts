/**
 * Applying the KEV catalogue to the advisory mirror.
 *
 * ## Full replacement, not an upsert
 *
 * Every other sync in this codebase adds and updates. This one also **clears**,
 * and that asymmetry is the whole design.
 *
 * CISA removes entries. It is rare — a handful a year, when a CVE turns out to
 * have been listed in error or is superseded — but `kev_listed_at` is the most
 * influential single input in `risk-model.ts`: it pins `exploitability` at 1.0,
 * which is a 10× multiplier over a typical advisory and puts the finding at the
 * top of every list in the product. An entry that is never cleared holds that
 * position forever, on evidence its own source has withdrawn. So a run computes
 * the set CISA currently publishes and makes the mirror match it, in both
 * directions, in one transaction.
 *
 * That is also why `config.minEntriesToApply` exists and is enforced here
 * rather than in the worker: for a replacement sync, a truncated file is not a
 * partial update, it is a mass deletion.
 *
 * ## Alias resolution, same as EPSS
 *
 * KEV is keyed by CVE and much of what the matcher finds is not, so the join
 * runs through `aliases` and OSV `upstream` (read off `raw_data`) as well as
 * `vuln_id`. `upstream` is not optional: a distro tracker record —
 * `UBUNTU-CVE-2026-31431`, the row that survives the collapse for every
 * Ubuntu deb finding — names its CVE there and nowhere else, so an alias-only
 * join left every Ubuntu finding unlisted (see `lib/vulnerability-aliases.ts`
 * for the same lesson on identity). Where an advisory aliases
 * several listed CVEs it takes the **earliest** `dateAdded` and the
 * **earliest** `dueDate` — "known exploited since" is a claim about the first
 * time any of them was confirmed, and the earliest deadline is the binding one.
 * Note this is the opposite reduction from EPSS's `max`, and for the same
 * reason: both pick the more urgent answer.
 */

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { recordStateFailure, upsertState } from "../db/single-row-state.js";
import { kevSyncState } from "../db/schema/threat-intel.js";
import type { KevEntry } from "./parser.js";
import { KEV_APPLY_LOCK_KEY } from "./config.js";
import { SyncLockHeldError } from "../lib/sync-lock.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("kev-sync:repository");

/** Thrown inside `apply`'s transaction. See the module header. */
export class ShortCatalogError extends Error {
    constructor(
        readonly entries: number,
        readonly minimum: number,
    ) {
        super(
            `KEV catalogue had ${entries} usable entries, below the ${minimum} floor — refusing to apply. ` +
                `This sync is a full replacement, so a truncated file would clear KEV from every CVE it omits.`,
        );
        this.name = "ShortCatalogError";
    }
}

export interface KevApplyResult {
    entriesInCatalog: number;
    /** CVEs in the catalogue that reached an advisory. */
    entriesMatched: number;
    /** Advisories whose KEV columns this run wrote or changed. */
    advisoriesListed: number;
    /** Advisories whose KEV columns this run cleared — CISA has delisted them. */
    advisoriesCleared: number;
    /**
     * Advisories that had no KEV listing before this run and have one now —
     * the subset of `advisoriesListed` that is news rather than a changed
     * due date. `services/kev-listing.service.ts` turns these into
     * `finding.kev-listed` events for the orgs running them.
     */
    newlyListed: { id: string; vulnId: string }[];
}

export interface KevRepository {
    getState(): Promise<typeof kevSyncState.$inferSelect | undefined>;
    apply(entries: KevEntry[], opts: { minEntries: number }): Promise<KevApplyResult>;
    recordSuccess(state: {
        catalogVersion: string | null;
        releasedAt: Date | null;
        entriesInCatalog: number;
        entriesMatched: number;
        entriesCleared: number;
    }): Promise<void>;
    recordFailure(message: string): Promise<void>;
    /** A run has passed the freshness guard and is fetching: stamp `run_started_at` for the app shell. */
    markRunning(): Promise<void>;
}

export function createKevRepository(): KevRepository {
    return {
        async getState() {
            const [row] = await db.select().from(kevSyncState).limit(1);
            return row;
        },

        async apply(entries, { minEntries }) {
            if (entries.length < minEntries) {
                // Checked before the transaction opens as well as being cheap
                // to check: unlike the EPSS feed, the whole catalogue is in
                // memory before any statement runs, so there is nothing to roll
                // back and no reason to start.
                throw new ShortCatalogError(entries.length, minEntries);
            }

            return db.transaction(async (tx) => {
                // Lift the pool's 120 s `statement_timeout` for this
                // transaction: the resolve step scans the whole mirror three
                // times and took 68–110 s once the mirror reached ~1.9M rows
                // (2026-09-07). Rationale in full next to the same line in
                // `epss-sync/repository.ts`.
                await tx.execute(sql`SET LOCAL statement_timeout = 0`);

                // One apply at a time across processes — transaction-scoped,
                // released with the commit or rollback. A second monolith
                // replica firing the same cron minute skips rather than
                // replacing the same rows a second time. See the same line
                // in `epss-sync/repository.ts`.
                const [lock] = await tx.execute<{ locked: boolean }>(
                    sql`SELECT pg_try_advisory_xact_lock(${KEV_APPLY_LOCK_KEY}) AS locked`,
                );
                if (!lock?.locked) throw new SyncLockHeldError("KEV");

                await tx.execute(sql`
                    CREATE TEMP TABLE kev_staging (
                        cve text PRIMARY KEY,
                        date_added timestamptz NOT NULL,
                        due_date timestamptz,
                        ransomware varchar(16)
                    ) ON COMMIT DROP
                `);

                await tx.execute(sql`
                    INSERT INTO kev_staging (cve, date_added, due_date, ransomware)
                    VALUES ${sql.join(
                        entries.map(
                            (e) => sql`(
                                ${e.cve},
                                ${e.dateAdded.toISOString()}::timestamptz,
                                ${e.dueDate?.toISOString() ?? null}::timestamptz,
                                ${e.ransomware}
                            )`,
                        ),
                        sql`, `,
                    )}
                    ON CONFLICT (cve) DO NOTHING
                `);

                // Both join paths, reduced per advisory. `min` on the dates —
                // see the module header for why this is the opposite of EPSS's
                // `max` and yet the same principle.
                //
                // `bool_or(ransomware = 'Known')` rather than an arbitrary
                // pick: if any CVE this advisory covers is used in ransomware
                // campaigns, the advisory is. The literals are CISA's own
                // vocabulary, restated rather than normalised, so the UI can
                // quote the source.
                await tx.execute(sql`
                    CREATE TEMP TABLE kev_resolved ON COMMIT DROP AS
                    WITH hits AS (
                        SELECT v.id AS vuln_pk, k.cve, k.date_added, k.due_date, k.ransomware
                        FROM vulnerabilities v
                        JOIN kev_staging k ON k.cve = upper(v.vuln_id)
                        UNION ALL
                        SELECT v.id AS vuln_pk, k.cve, k.date_added, k.due_date, k.ransomware
                        FROM vulnerabilities v
                        CROSS JOIN LATERAL jsonb_array_elements_text(
                            coalesce(v.aliases, '[]'::jsonb)
                        ) AS a(alias)
                        JOIN kev_staging k ON k.cve = upper(a.alias)
                        UNION ALL
                        SELECT v.id AS vuln_pk, k.cve, k.date_added, k.due_date, k.ransomware
                        FROM vulnerabilities v
                        CROSS JOIN LATERAL jsonb_array_elements_text(
                            coalesce(v.raw_data->'upstream', '[]'::jsonb)
                        ) AS u(upstream)
                        JOIN kev_staging k ON k.cve = upper(u.upstream)
                    )
                    SELECT vuln_pk,
                           min(date_added) AS date_added,
                           min(due_date) AS due_date,
                           CASE WHEN bool_or(ransomware = 'Known') THEN 'Known' ELSE 'Unknown' END
                               AS ransomware
                    FROM hits
                    GROUP BY vuln_pk
                `);

                const matched = await tx.execute<{ n: string }>(sql`
                    SELECT count(*)::text AS n FROM kev_resolved
                `);

                // Who is about to be listed for the first time — read before
                // the UPDATE overwrites the evidence. Bounded by the
                // catalogue's daily additions on every run but the first.
                await tx.execute(sql`
                    CREATE TEMP TABLE kev_newly_listed ON COMMIT DROP AS
                    SELECT r.vuln_pk
                    FROM kev_resolved r
                    JOIN vulnerabilities v ON v.id = r.vuln_pk
                    WHERE v.kev_listed_at IS NULL
                `);

                const listed = await tx.execute<{ n: string }>(sql`
                    WITH applied AS (
                        UPDATE vulnerabilities v
                        SET kev_listed_at = r.date_added,
                            kev_due_date = r.due_date,
                            kev_ransomware = r.ransomware,
                            updated_at = now()
                        FROM kev_resolved r
                        WHERE v.id = r.vuln_pk
                          AND (v.kev_listed_at IS DISTINCT FROM r.date_added
                            OR v.kev_due_date IS DISTINCT FROM r.due_date
                            OR v.kev_ransomware IS DISTINCT FROM r.ransomware)
                        RETURNING 1
                    )
                    SELECT count(*)::text AS n FROM applied
                `);

                // The clearing half. Scoped by the partial index on
                // `kev_listed_at IS NOT NULL`, so it reads the few thousand
                // rows that could possibly need clearing rather than the whole
                // table.
                const cleared = await tx.execute<{ n: string }>(sql`
                    WITH delisted AS (
                        UPDATE vulnerabilities v
                        SET kev_listed_at = NULL,
                            kev_due_date = NULL,
                            kev_ransomware = NULL,
                            updated_at = now()
                        WHERE v.kev_listed_at IS NOT NULL
                          AND NOT EXISTS (
                              SELECT 1 FROM kev_resolved r WHERE r.vuln_pk = v.id
                          )
                        RETURNING 1
                    )
                    SELECT count(*)::text AS n FROM delisted
                `);

                const newlyListed = await tx.execute<{ id: string; vuln_id: string }>(sql`
                    SELECT v.id, v.vuln_id
                    FROM kev_newly_listed n
                    JOIN vulnerabilities v ON v.id = n.vuln_pk
                    ORDER BY v.vuln_id
                `);

                const result: KevApplyResult = {
                    entriesInCatalog: entries.length,
                    entriesMatched: Number(matched[0]?.n ?? 0),
                    advisoriesListed: Number(listed[0]?.n ?? 0),
                    advisoriesCleared: Number(cleared[0]?.n ?? 0),
                    newlyListed: [...newlyListed].map((r) => ({ id: r.id, vulnId: r.vuln_id })),
                };

                if (result.advisoriesCleared > 0) {
                    // Worth a line of its own: a delisting is rare, and it
                    // silently demotes findings that were at the top of every
                    // list yesterday. If this number is ever large, the join
                    // broke rather than CISA having second thoughts.
                    log.warn(
                        { advisoriesCleared: result.advisoriesCleared },
                        "Advisories no longer on the KEV catalogue — cleared",
                    );
                }

                return result;
            });
        },

        async recordSuccess(state) {
            await upsertState(kevSyncState, {
                lastSyncedAt: new Date(),
                catalogVersion: state.catalogVersion,
                releasedAt: state.releasedAt,
                entriesInCatalog: state.entriesInCatalog,
                entriesMatched: state.entriesMatched,
                entriesCleared: state.entriesCleared,
                lastError: null,
                runStartedAt: null,
            });
        },

        async recordFailure(message) {
            await recordStateFailure(kevSyncState, message, { runStartedAt: null });
        },

        async markRunning() {
            await upsertState(kevSyncState, { runStartedAt: new Date() });
        },
    };
}
