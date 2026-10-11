/**
 * Applying the Artifact Hub dump to the mirror.
 *
 * The write is the `replaceEntries` stamp-and-prune shape
 * (`chart-repository.repository.ts`): batched upsert on the dump's natural key
 * `(repo_name, name)` stamping `last_seen_at`, then delete everything the run
 * did not stamp. One transaction, so a failed run leaves yesterday's mirror
 * intact rather than a half-pruned one. No temp-table staging — 18k rows is
 * two orders of magnitude below the EPSS join that machinery exists for.
 *
 * The prune is why the floor check matters: rows deleted here cascade the
 * phase-2 `chart_attributions` that reference them, so a truncated dump would
 * not just shrink the mirror, it would silently strip attributions. `minRows`
 * is enforced by the caller passing it in — the repository enforces the floor,
 * the caller owns what the floor is (same split as `epss-sync/repository.ts`).
 */

import { lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { recordStateFailure, upsertState } from "../db/single-row-state.js";
import { artifactHubPackages, artifactHubSyncState } from "../db/schema/artifact-hub.js";
import type { ParsedArtifactHubPackage } from "./parser.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("artifacthub-sync:repository");

/** Thrown inside `apply` before anything is written; see the module docblock. */
export class ShortDumpError extends Error {
    constructor(
        readonly packages: number,
        readonly minimum: number,
    ) {
        super(
            `Artifact Hub dump had ${packages} usable packages, below the ${minimum} floor — ` +
                `refusing to apply. A truncated dump would prune live mirror rows and their attributions.`,
        );
        this.name = "ShortDumpError";
    }
}

export interface ArtifactHubApplyResult {
    packagesApplied: number;
    packagesPruned: number;
}

export interface ArtifactHubSyncRepository {
    getState(): Promise<typeof artifactHubSyncState.$inferSelect | undefined>;
    /**
     * Upsert every package with `lastSeenAt = stamp`, then prune rows older
     * than the stamp. One transaction; throws `ShortDumpError` (before any
     * write) when the dump is below `minPackages`.
     */
    apply(
        packages: ParsedArtifactHubPackage[],
        opts: { stamp: Date; batchSize: number; minPackages: number },
    ): Promise<ArtifactHubApplyResult>;
    recordSuccess(state: { packagesInDump: number; packagesApplied: number }): Promise<void>;
    /** Written after the attribution pass, whether or not the mirror ran. */
    recordAttributionStats(stats: {
        chartsExamined: number;
        attributionsWritten: number;
        attributionsRefused: number;
        reposAutoAdded: number;
    }): Promise<void>;
    recordFailure(message: string): Promise<void>;
}

export function createArtifactHubSyncRepository(): ArtifactHubSyncRepository {
    return {
        async getState() {
            const [row] = await db.select().from(artifactHubSyncState).limit(1);
            return row;
        },

        async apply(packages, { stamp, batchSize, minPackages }) {
            if (packages.length < minPackages) {
                throw new ShortDumpError(packages.length, minPackages);
            }

            return db.transaction(async (tx) => {
                for (let i = 0; i < packages.length; i += batchSize) {
                    const batch = packages.slice(i, i + batchSize);
                    await tx
                        .insert(artifactHubPackages)
                        .values(batch.map((p) => ({ ...p, lastSeenAt: stamp })))
                        .onConflictDoUpdate({
                            target: [artifactHubPackages.repoName, artifactHubPackages.name],
                            set: {
                                repoUrl: sql`excluded.repo_url`,
                                description: sql`excluded.description`,
                                latestVersion: sql`excluded.latest_version`,
                                stars: sql`excluded.stars`,
                                repoOfficial: sql`excluded.repo_official`,
                                repoVerified: sql`excluded.repo_verified`,
                                official: sql`excluded.official`,
                                homeUrl: sql`excluded.home_url`,
                                versions: sql`excluded.versions`,
                                lastSeenAt: stamp,
                                updatedAt: stamp,
                            },
                        });
                }

                const pruned = await tx
                    .delete(artifactHubPackages)
                    .where(lt(artifactHubPackages.lastSeenAt, stamp))
                    .returning({ id: artifactHubPackages.id });

                log.info(
                    { packagesApplied: packages.length, packagesPruned: pruned.length },
                    "Artifact Hub mirror applied",
                );

                return { packagesApplied: packages.length, packagesPruned: pruned.length };
            });
        },

        async recordSuccess(state) {
            await upsertState(artifactHubSyncState, {
                lastSyncedAt: new Date(),
                packagesInDump: state.packagesInDump,
                packagesApplied: state.packagesApplied,
                lastError: null,
            });
        },

        async recordAttributionStats(stats) {
            await upsertState(artifactHubSyncState, stats);
        },

        async recordFailure(message) {
            await recordStateFailure(artifactHubSyncState, message);
        },
    };
}
