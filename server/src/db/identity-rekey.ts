import { sql, type SQL } from "drizzle-orm";
import { db, type Transaction } from "./index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("identity-rekey");

/** One advisory record whose stored `finding_identity` the sync just rewrote. */
export interface IdentityMove {
    vulnId: string;
    from: string;
    to: string;
}

/**
 * Carry the tables keyed on a finding identity along when an advisory's
 * identity moves.
 *
 * `finding_states` (suppressions) and finding-scope `issues` store the
 * identity string, not an advisory — deliberately, so they follow a finding
 * across digests. But an identity is not permanent: a GHSA published without
 * a CVE is `#GHSA-…` until GitHub adds the CVE a day later, then `CVE-…`
 * (`lib/vulnerability-aliases.ts#findingIdentityOf`). Left alone, the old key
 * matches nothing: the suppression silently lapses, and worse, the post-scan
 * sweep (`verifyFindingIssues`) finds no finding under the issue's identity
 * and marks it **verified** — "fixed" — while the vulnerability is still
 * there under its new name.
 *
 * The invariant kept: a keyed row's `vuln_identity` is the identity of its
 * `vuln_id` — the advisory the user acted on — which is exactly how the
 * service wrote it (`resolveVulnIdentity`). So when a record moves, the rows
 * written against *that record* move with it, and nothing else does: a GO
 * record gaining its CVE before the GHSA it aliases leaves a suppression
 * placed on the GHSA where it is until the GHSA moves too. (The verify sweep
 * does not call that issue fixed meanwhile — `findingIssuesStillNamed`.)
 *
 * A suppression already present under the new key wins, and the old one is
 * dropped rather than left as a dead row. Issues have no such constraint and
 * all move. Runs inside the upsert's transaction (`bulkUpsertFromSync`), so a
 * crash cannot leave a rewritten identity behind with its keyed rows on the
 * old one — the next sync would see no change and never repair it.
 */
export async function rekeyMovedIdentities(
    moves: IdentityMove[],
    executor: typeof db | Transaction = db
): Promise<{ suppressions: number; issues: number }> {
    if (moves.length === 0) return { suppressions: 0, issues: 0 };

    const moved = sql`unnest(
        ${textArray(moves.map((m) => m.vulnId))},
        ${textArray(moves.map((m) => m.from))},
        ${textArray(moves.map((m) => m.to))}
    ) AS m(vuln_id, from_id, to_id)`;

    const superseded = await executor.execute(sql`
        DELETE FROM finding_states fs
         USING ${moved}
         WHERE fs.vuln_id = m.vuln_id
           AND fs.vuln_identity = m.from_id
           AND EXISTS (
                 SELECT 1 FROM finding_states k
                  WHERE k.org_id = fs.org_id
                    AND k.package_type = fs.package_type
                    AND k.package_name = fs.package_name
                    AND k.vuln_identity = m.to_id)
    `);
    const suppressions = await executor.execute(sql`
        UPDATE finding_states fs
           SET vuln_identity = m.to_id, updated_at = now()
          FROM ${moved}
         WHERE fs.vuln_id = m.vuln_id AND fs.vuln_identity = m.from_id
    `);
    const issues = await executor.execute(sql`
        UPDATE issues i
           SET vuln_identity = m.to_id, updated_at = now()
          FROM ${moved}
         WHERE i.scope = 'finding' AND i.vuln_id = m.vuln_id AND i.vuln_identity = m.from_id
    `);

    const result = { suppressions: suppressions.count ?? 0, issues: issues.count ?? 0 };
    if (result.suppressions > 0 || result.issues > 0 || (superseded.count ?? 0) > 0) {
        log.info({ ...result, suppressionsSuperseded: superseded.count ?? 0 }, "Re-keyed moved finding identities");
    }
    return result;
}

function textArray(values: string[]): SQL {
    return sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `
    )}]::text[]`;
}
