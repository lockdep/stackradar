/**
 * Backfill `vulnerability_affected_packages.release_version` for rows written
 * before the column existed (migration 0009, db plan item 4).
 *
 * The value is `releaseVersion(ecosystem_release)` — the same TypeScript
 * function the OSV sync writes with — so the mapping is computed here, once
 * per distinct `ecosystem_release` (a few hundred values), and applied as a
 * VALUES join. Rows whose release names no version stay NULL, which the
 * store treats as "applies to every release"; so does a row this script has
 * not reached yet, which is what makes it safe to run against a live
 * server, in any number of attempts, and to interrupt.
 *
 * Batched by primary-key range (the first byte of the uuid, 256 batches of
 * ~27k rows on a 6.8M-row mirror) so no statement holds the row locks or the
 * WAL for the whole table, and so each fits comfortably under any
 * statement_timeout. Own connection, no statement_timeout: the first pass —
 * the distinct-value scan — reads the whole table once.
 *
 *   pnpm backfill:release-version           # apply
 *   pnpm backfill:release-version --dry-run # mapping and row counts only
 *
 * A full OSV rebuild (a new generation) writes the column for every row it
 * inserts, so after the next bootstrap this script has nothing to do.
 */

import "dotenv/config";
import postgres from "postgres";
import { config } from "../config/index.js";
import { releaseVersion } from "../matching/ecosystem.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("backfill-release-version");

async function main(): Promise<void> {
    const dryRun = process.argv.includes("--dry-run");
    const sql = postgres(config.database.url, {
        max: 1,
        connection: { jit: config.database.jit, work_mem: config.database.workMem },
        ...(config.database.caCert
            ? { ssl: { rejectUnauthorized: true, ca: config.database.caCert } }
            : {}),
    });

    try {
        const releases = await sql<{ release: string; n: string }[]>`
            SELECT ecosystem_release AS release, count(*)::bigint AS n
              FROM vulnerability_affected_packages
             WHERE release_version IS NULL AND ecosystem_release IS NOT NULL
             GROUP BY 1
        `;

        const mapping: { release: string; version: string }[] = [];
        let unparsable = 0;
        for (const { release, n } of releases) {
            const version = releaseVersion(release);
            if (version === null) {
                unparsable += Number(n);
                continue;
            }
            mapping.push({ release, version });
        }
        const pending = mapping.reduce(
            (sum, m) => sum + Number(releases.find((r) => r.release === m.release)?.n ?? 0),
            0
        );
        log.info(
            { distinctReleases: releases.length, mapped: mapping.length, pendingRows: pending, unparsableRows: unparsable },
            dryRun ? "Dry run — nothing written" : "Backfilling release_version"
        );
        if (dryRun || mapping.length === 0) return;

        const values = mapping.map((m) => [m.release, m.version]);
        let updated = 0;
        for (let prefix = 0; prefix < 256; prefix++) {
            const lo = `${prefix.toString(16).padStart(2, "0")}000000-0000-0000-0000-000000000000`;
            const hi = `${(prefix + 1).toString(16).padStart(2, "0")}000000-0000-0000-0000-000000000000`;
            const upper = prefix === 255 ? sql`` : sql`AND id < ${hi}::uuid`;
            const result = await sql`
                UPDATE vulnerability_affected_packages AS vap
                   SET release_version = m.version
                  FROM (values ${sql(values)}) AS m(release, version)
                 WHERE vap.id >= ${lo}::uuid ${upper}
                   AND vap.release_version IS NULL
                   AND vap.ecosystem_release = m.release
            `;
            updated += result.count;
            if (prefix % 32 === 31) log.info({ batches: prefix + 1, updated }, "Progress");
        }
        await sql`ANALYZE vulnerability_affected_packages`;
        log.info({ updated }, "Backfill complete");
    } finally {
        await sql.end();
    }
}

main().catch((error) => {
    log.error({ err: error }, "Backfill failed");
    process.exit(1);
});
