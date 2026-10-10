import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { SyncCycleResult } from "./types.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync:rescan");

/**
 * Did this cycle change what the mirror would answer?
 *
 * A completed bootstrap always did — a whole generation was swapped in. An
 * incremental run only did if it inserted or updated records; `unchanged`
 * rows and empty runs leave every existing match verdict exactly as valid as
 * it was an hour ago, and re-matching the fleet against an identical mirror
 * is pure load.
 */
export function mirrorChanged(result: SyncCycleResult): boolean {
    if (!result.success || result.skipped || result.noop) return false;
    if (result.mode === "initialization") return true;
    return result.inserted + result.updated > 0;
}

/**
 * Queue a `scheduled_scan` for every image that has an SBOM, after a sync
 * cycle that changed the mirror.
 *
 * This is what turns the hourly mirror sync into hourly *findings*: matching
 * only ever runs inside a scan job, and before this existed the only triggers
 * were SBOM upload and a human — so an image was matched once, when first
 * seen, and a CVE published against it afterwards never surfaced. The job
 * worker drains the queue at its own pace; this function only writes rows.
 *
 * One INSERT..SELECT rather than a job per image through `jobService`: the
 * fleet-wide sweep is a set operation, and doing it row-by-row from here
 * would hold the sync process hostage to queue size. The NOT EXISTS keeps it
 * from stacking up behind itself — an image with a scan already pending,
 * scheduled or running gets nothing, so a slow worker sees a bounded queue
 * no matter how many sync cycles pass. Concurrent enqueues can't race the
 * guard: the advisory lock means one sync process at a time, and losing the
 * race to an sbom_upload scan just means one redundant, idempotent match.
 *
 * Priority 1 — below upload-triggered scans (5) and manually scheduled ones
 * (3). A fresh SBOM's first findings matter more than the fleet's hourly
 * refresh, and the queue index orders by priority first.
 *
 * Failure is logged and swallowed, like the failure-retention sweep: the
 * sync itself applied its records correctly, and the next changed cycle
 * re-enqueues everything this one missed.
 */
export async function enqueueRescansAfterMirrorChange(result: SyncCycleResult): Promise<number> {
    if (!mirrorChanged(result)) return 0;

    try {
        const rows = await db.execute<{ id: string }>(sql`
            INSERT INTO jobs (org_id, image_id, sbom_id, type, status, priority, title, triggered_by)
            SELECT
                i.org_id,
                i.id,
                s.id,
                'scheduled_scan',
                'pending',
                1,
                coalesce(i.repository, i.registry, 'image') || '@' || left(i.digest, 19) || ': Scheduled Security Scan',
                'schedule'
            FROM images i
            JOIN sboms s ON s.image_id = i.id
            WHERE NOT EXISTS (
                SELECT 1 FROM jobs j
                WHERE j.image_id = i.id
                  AND j.type IN ('vulnerability_scan', 'scheduled_scan')
                  AND j.status IN ('pending', 'scheduled', 'processing')
            )
            RETURNING id
        `);

        log.info(
            { enqueued: rows.length, mode: result.mode, inserted: result.inserted, updated: result.updated },
            "Queued fleet rescan after mirror change"
        );
        return rows.length;
    } catch (error) {
        log.error(
            { error: error instanceof Error ? error.message : String(error) },
            "Failed to enqueue rescans after mirror change — findings stay on the previous mirror data until the next changed cycle"
        );
        return 0;
    }
}
