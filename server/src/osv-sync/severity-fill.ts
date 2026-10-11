import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { createLogger } from "../lib/logger.js";
import { PLACEHOLDER_SCORERS } from "./cvss.js";

const log = createLogger("osv-sync:severity-fill");

/**
 * Give an advisory that publishes no severity the severity of the flaw it
 * describes.
 *
 * The matcher matches ecosystem advisories, because they carry the version
 * ranges: a Go binary matches `GO-2026-4918`, never `CVE-2026-33814`, whose
 * record from the CVE list has no usable ranges. But the Go vuln DB never
 * states CVSS — nor do most `CGA-`, `MINI-`, `ECHO-` and `BELL-` records — so
 * the finding reported as `CVE-2026-33814` rendered Unscored and ranked on
 * `UNSCORED_SEVERITY`, while five other records of the same identity say 7.5.
 * Measured before this existed: 230 of the 261 unscored advisories any
 * component matched had a scored record under the same identity. It is the
 * same systematic bias `epss-sync/repository.ts` describes for EPSS — whole
 * ecosystems ranking on a fallback — and it gets the same answer: attach the
 * identity's fact to every record of it. grype does exactly this at DB build
 * (`fillInMissingSeverity`, grype/db/v6/build/writer.go), copying NVD's
 * severity onto every record left without one.
 *
 * The rules:
 *
 *   - **A record's own severity always wins.** Only a record whose parse found
 *     none (`cvss_score` null and `severity_level` outside the four bands)
 *     borrows. A distro that rates a CVE differently keeps its rating.
 *   - **Which record lends:** one with its own severity (never a borrowed
 *     one, so there are no chains), not withdrawn, of the same identity;
 *     among those one stating a CVSS score, then the record the identity is
 *     named after (the CVE record with the CNA's vector, or the GHSA of a
 *     `#GHSA-…` group), then the highest score, then the worst band, then
 *     `vuln_id` so the choice is stable.
 *   - **A placeholder score is no score.** Cleanstart stamps one vector —
 *     `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`, 9.8 — on every record it scores
 *     at all, so `cvss.ts` now parses those records as unscored
 *     (`PLACEHOLDER_SCORERS` there) and they borrow like any other. The
 *     publisher is also refused as a lender here, belt and braces: rows
 *     ingested before that rule carry the 9.8 until migration 0025 resets
 *     them, and the first dev backfill (2026-09-30) showed what lending it
 *     does — 31 Go advisories critical that Ubuntu, Debian, Red Hat and
 *     Bitnami all rate medium or high, because for a 2026 CVE the mirror
 *     lacks a CVE record and "highest score" was Cleanstart's.
 *   - **Non-CVE identities lend too.** `GO-2026-6061` and the GHSA it
 *     aliases share `#GHSA-hrxh-6v49-42gf` (`soleGhsaIdentity`), and the GO
 *     record is as unscored there as under a CVE. A `#<own id>` identity is
 *     one record, so it simply finds no lender.
 *   - **The copy says where it came from.** `severity_source` is the lender's
 *     `vuln_id`, so the UI can say "7.5 from CVE-2026-33814" rather than
 *     passing a borrowed number off as the Go team's.
 *
 * `risk_score` is generated over the two columns, so it follows for free.
 *
 * Every OSV upsert restates a record's own values and nulls `severity_source`
 * (`bulkUpsertFromSync`), so a borrowed score can go stale only until the
 * next fill for its identity — which is why the scoped form below re-resolves
 * every identity a changed record belongs to *or lent to*. The second half
 * matters when a lender leaves its identity (its aliases changed): the rows
 * that borrowed from it are no longer found through the identity it is in.
 */
/** The publishers `cvss.ts` refuses a placeholder from, refused as lenders too. Matched on `id_prefix`. */
const PLACEHOLDER_LENDERS = Object.keys(PLACEHOLDER_SCORERS);

export async function fillInheritedSeverity(scope: { vulnIds: string[] } | "all"): Promise<number> {
    if (scope !== "all" && scope.vulnIds.length === 0) return 0;

    const started = Date.now();
    const identities: SQL =
        scope === "all"
            ? sql`SELECT DISTINCT finding_identity AS identity FROM vulnerabilities`
            : sql`
                SELECT DISTINCT v.finding_identity AS identity
                  FROM vulnerabilities v
                 WHERE v.vuln_id = ANY(${idArray(scope.vulnIds)})
                    OR v.severity_source = ANY(${idArray(scope.vulnIds)})
            `;

    const fill = sql`
        WITH scope AS (${identities}),
        lender AS (
            SELECT DISTINCT ON (v.finding_identity)
                   v.finding_identity AS identity, v.vuln_id, v.severity_level, v.cvss_score
              FROM vulnerabilities v
              JOIN scope s ON s.identity = v.finding_identity
             WHERE v.severity_source IS NULL
               AND v.withdrawn_at IS NULL
               AND v.id_prefix <> ALL(${idArray(PLACEHOLDER_LENDERS)})
               AND ${hasOwnSeverity(sql`v`)}
             ORDER BY v.finding_identity,
                      (v.cvss_score IS NOT NULL) DESC,
                      (v.vuln_id = ltrim(v.finding_identity, '#')) DESC,
                      v.cvss_score DESC NULLS LAST,
                      ${bandRank(sql`v`)} DESC,
                      v.vuln_id
        ),
        target AS (
            SELECT v.id,
                   l.vuln_id AS source,
                   coalesce(l.severity_level, 'unknown') AS severity_level,
                   l.cvss_score
              FROM vulnerabilities v
              JOIN scope s ON s.identity = v.finding_identity
              LEFT JOIN lender l ON l.identity = v.finding_identity
             WHERE v.severity_source IS NOT NULL
                OR NOT ${hasOwnSeverity(sql`v`)}
        )
        UPDATE vulnerabilities v
           SET severity_source = t.source,
               severity_level  = t.severity_level,
               cvss_score      = t.cvss_score
          FROM target t
         WHERE v.id = t.id
           AND (v.severity_source IS DISTINCT FROM t.source
                OR v.severity_level IS DISTINCT FROM t.severity_level
                OR v.cvss_score IS DISTINCT FROM t.cvss_score)
    `;

    // A scoped fill is a batch's handful of identities and keeps the pool's
    // 120 s `statement_timeout`. The whole-mirror pass sorts every scored
    // record of ~1.9M and ran past it on the first dev backfill
    // (2026-09-29), so it lifts the limit for its own transaction, as the
    // EPSS and KEV applies do; the Job deadline is the real ceiling.
    const result =
        scope === "all"
            ? await db.transaction(async (tx) => {
                  await tx.execute(sql`SET LOCAL statement_timeout = 0`);
                  return tx.execute(fill);
              })
            : await db.execute(fill);

    const updated = result.count ?? 0;
    log.info(
        { scope: scope === "all" ? "all" : scope.vulnIds.length, updated, durationMs: Date.now() - started },
        "Filled inherited severities",
    );
    return updated;
}

/** A record's parse found a severity: a CVSS score, or one of the four bands. */
function hasOwnSeverity(v: SQL): SQL {
    return sql`(${v}.cvss_score IS NOT NULL OR lower(coalesce(${v}.severity_level, '')) IN ('critical', 'high', 'medium', 'low'))`;
}

/** `critical` > `high` > `medium` > `low`, as `severityRank` in `db/findings.ts`. */
function bandRank(v: SQL): SQL {
    return sql`CASE lower(coalesce(${v}.severity_level, ''))
        WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`;
}

function idArray(ids: string[]): SQL {
    return sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
    )}]::text[]`;
}
