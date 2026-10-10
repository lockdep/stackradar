/**
 * Backfill `components.tier` for rows classified by an older rule set — or
 * never classified at all (component tier plan, item 1).
 *
 * Every component property syft wrote is already in `component_properties`,
 * so the tier is re-computable without a rescan: this reads the three
 * properties `lib/component-tier.ts` needs and runs the same pure classifier
 * the ingest path uses. Rows at or above `TIER_VERSION` are left alone, which
 * is what makes it idempotent, resumable and safe to interrupt: a batch that
 * committed is simply not selected again.
 *
 * Batches of 5 000 components, keyset on `id` (uuidv7, so roughly ingest
 * order), each batch one SELECT and one UPDATE … FROM (VALUES …). Own
 * connection, no statement_timeout.
 *
 *   pnpm backfill:component-tier            # apply
 *   pnpm backfill:component-tier --dry-run  # classify and print the histogram only
 *
 * After `pnpm build` the script is `dist/src/scripts/backfill-component-tier.js`.
 */

import "dotenv/config";
import postgres from "postgres";
import { config } from "../config/index.js";
import { TIER_VERSION } from "../lib/component-tier.js";
import { backfillComponentTier } from "../lib/component-tier-backfill.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("backfill-component-tier");

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
        const result = await backfillComponentTier(sql, {
            dryRun,
            onProgress: (seen) => {
                if (seen % 100_000 === 0) log.info({ seen }, "Progress");
            },
        });
        log.info(
            { ...result, tierVersion: TIER_VERSION },
            dryRun ? "Dry run — nothing written" : "Backfill complete"
        );
    } finally {
        await sql.end();
    }
}

main().catch((error) => {
    log.error({ err: error }, "Backfill failed");
    process.exit(1);
});
