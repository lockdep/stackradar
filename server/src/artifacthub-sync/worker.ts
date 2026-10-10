/**
 * The Artifact Hub sync cycle:
 * lock → guard → download → parse → apply → attribute → record.
 *
 * The attribution pass runs even when the mirror is fresh-skipped — the
 * inventory moves on every scanner report, so yesterday's mirror still has
 * new charts to attribute — and it runs *inside* the advisory lock, because
 * its stamp-and-prune write is no safer under interleaving than the mirror's.
 */

import postgres from "postgres";
import type { ArtifactHubSyncConfig } from "./config.js";
import type { ArtifactHubDownloader } from "./downloader.js";
import type { ArtifactHubSyncRepository } from "./repository.js";
import { parsePackages } from "./parser.js";
import { runAttributionPass, type AttributionPassStats } from "./attribution.js";
import { isStateFresh } from "../db/single-row-state.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("artifacthub-sync");

export interface ArtifactHubSyncResult {
    /** True when the *mirror refresh* did not run. Attribution still ran unless `locked`. */
    skipped: boolean;
    reason?: "fresh" | "locked";
    packagesInDump?: number;
    packagesApplied?: number;
    packagesPruned?: number;
    malformed?: number;
    duplicates?: number;
    attribution?: AttributionPassStats;
    durationMs?: number;
}

export function createArtifactHubSyncWorker(
    config: ArtifactHubSyncConfig,
    downloader: ArtifactHubDownloader,
    repository: ArtifactHubSyncRepository
) {
    return {
        async runOnce(options?: { force?: boolean }): Promise<ArtifactHubSyncResult> {
            const startedAt = Date.now();

            // Session advisory lock on a dedicated single-connection client:
            // the lock lives exactly as long as the connection, so ending the
            // client in `finally` releases it on every path, including a
            // crash mid-apply. Guards cron-vs-CLI overlap — neither the
            // mirror's stamp-and-prune nor the attribution pass's is safe
            // under interleaved runs.
            const lockClient = postgres(config.databaseUrl, { max: 1 });
            try {
                const [lock] = await lockClient<[{ locked: boolean }]>`
                    SELECT pg_try_advisory_lock(${config.advisoryLockId}) AS locked
                `;
                if (!lock?.locked) {
                    log.warn(
                        { advisoryLockId: config.advisoryLockId },
                        "Another Artifact Hub sync holds the lock, skipping"
                    );
                    return { skipped: true, reason: "locked" };
                }

                const mirrorFresh = await isStateFresh({
                    force: options?.force,
                    minSyncIntervalHours: config.minSyncIntervalHours,
                    getState: () => repository.getState(),
                    log,
                    message: "Artifact Hub mirror is fresh, skipping refresh",
                });

                let mirror: {
                    packagesInDump: number;
                    packagesApplied: number;
                    packagesPruned: number;
                    malformed: number;
                    duplicates: number;
                } | null = null;

                if (!mirrorFresh) {
                    const raw = await downloader.fetchDump();
                    const packagesInDump = Array.isArray(raw) ? raw.length : 0;
                    const { packages, malformed, duplicates } = parsePackages(raw);

                    const applied = await repository.apply(packages, {
                        stamp: new Date(),
                        batchSize: config.stagingBatchSize,
                        minPackages: config.minPackagesToApply,
                    });

                    await repository.recordSuccess({
                        packagesInDump,
                        packagesApplied: applied.packagesApplied,
                    });
                    mirror = { packagesInDump, ...applied, malformed, duplicates };
                }

                const attribution = await runAttributionPass();
                await repository.recordAttributionStats(attribution);

                const durationMs = Date.now() - startedAt;
                log.info(
                    { ...(mirror ?? { mirrorFresh }), attribution, durationMs },
                    "Artifact Hub sync complete"
                );

                return mirror
                    ? { skipped: false, ...mirror, attribution, durationMs }
                    : { skipped: true, reason: "fresh", attribution, durationMs };
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err }, "Artifact Hub sync failed");
                await repository.recordFailure(message);
                throw err;
            } finally {
                await lockClient.end();
            }
        },
    };
}
