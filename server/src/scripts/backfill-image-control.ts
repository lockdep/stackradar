/**
 * Resolve `images.control` for every image of every org (component tier plan,
 * item 11) — the one-off after the column ships. The same resolver the ingest
 * path and the nightly attribution pass use, so it is idempotent and safe to
 * re-run; it writes only the rows whose verdict changed.
 *
 *   pnpm backfill:image-control
 *
 * Logs a histogram per deciding signal (`control_detected_by`); `unknown` is
 * what the confirm-once prompt will ask about. After `pnpm build` the script
 * is `dist/src/scripts/backfill-image-control.js`.
 */

import "dotenv/config";
import { orgsWithImages, resolveImageControl } from "../services/image-control.service.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("backfill-image-control");

async function main(): Promise<void> {
    const orgs = await orgsWithImages();
    const histogram: Record<string, number> = {};
    let images = 0;
    let changed = 0;

    for (const orgId of orgs) {
        const stats = await resolveImageControl(orgId);
        images += stats.images;
        changed += stats.changed;
        for (const [signal, n] of Object.entries(stats.histogram)) histogram[signal] = (histogram[signal] ?? 0) + n;
    }

    log.info(
        {
            orgs: orgs.length,
            images,
            changed,
            histogram,
            unknownShare: images === 0 ? 0 : Number(((histogram["unknown"] ?? 0) / images).toFixed(4)),
        },
        "Image control backfill complete"
    );
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        log.error({ err: error }, "Image control backfill failed");
        process.exit(1);
    });
