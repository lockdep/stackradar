/**
 * The KEV sync cycle: guard → fetch → parse → replace → record.
 *
 * No streaming and no separate downloader module. The catalogue is under a
 * megabyte of JSON that has to be parsed whole before any of it is usable, so
 * the machinery `epss-sync` needs for a 15 MB CSV would be ceremony here.
 */

import type { KevSyncConfig } from "./config.js";
import type { KevApplyResult, KevRepository } from "./repository.js";
import { parseCatalog, type KevCatalog } from "./parser.js";
import { isStateFresh } from "../db/single-row-state.js";
import { SyncLockHeldError } from "../lib/sync-lock.js";
import { fetchWithRetry } from "../lib/http-retry.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("kev-sync");

export interface KevSyncResult {
    skipped: boolean;
    reason?: string;
    catalogVersion?: string | null;
    entriesInCatalog?: number;
    entriesMatched?: number;
    advisoriesListed?: number;
    advisoriesCleared?: number;
    malformedEntries?: number;
    durationMs?: number;
}

export interface KevSyncHooks {
    /**
     * Called after a successful apply with the advisories listed for the
     * first time and the state *before* the run (so a first run can be told
     * apart). The CLI wires `recordKevListings`; a failure here is logged
     * and does not fail the sync — the columns are already written.
     */
    onNewlyListed?: (
        listed: KevApplyResult["newlyListed"],
        previous: { lastSyncedAt: Date | null } | undefined,
    ) => Promise<unknown>;
}

export function createKevSyncWorker(config: KevSyncConfig, repository: KevRepository, hooks: KevSyncHooks = {}) {
    async function fetchCatalog(): Promise<KevCatalog> {
        // The parse runs inside the retry loop (`consume`): a transient
        // failure while reading the body is worth another attempt, but a JSON
        // or shape error is not — the next attempt fetches the same bytes —
        // which is what `shouldRethrow` picks apart.
        return fetchWithRetry(
            config.feedUrl,
            {
                label: "KEV",
                log,
                maxRetries: config.maxRetries,
                retryBaseDelayMs: config.retryBaseDelayMs,
                requestTimeoutMs: config.requestTimeoutMs,
                headers: { "User-Agent": config.userAgent, Accept: "application/json" },
                shouldRethrow: (err) =>
                    err instanceof SyntaxError || Boolean((err as Error).message?.startsWith("KEV feed")),
            },
            async (response) => parseCatalog(await response.json()),
        );
    }

    return {
        async runOnce(options?: { force?: boolean }): Promise<KevSyncResult> {
            const startedAt = Date.now();

            if (
                await isStateFresh({
                    force: options?.force,
                    minSyncIntervalHours: config.minSyncIntervalHours,
                    getState: () => repository.getState(),
                    log,
                    message: "KEV catalogue is fresh, skipping",
                })
            ) {
                return { skipped: true, reason: "fresh" };
            }

            try {
                const catalog = await fetchCatalog();

                if (
                    catalog.declaredCount != null &&
                    catalog.declaredCount !== catalog.entries.length + catalog.malformed
                ) {
                    // Not fatal — CISA's `count` has disagreed with the array
                    // before — but it is the cheapest available check that the
                    // download was complete, so it is worth saying out loud.
                    log.warn(
                        {
                            declaredCount: catalog.declaredCount,
                            parsed: catalog.entries.length,
                            malformed: catalog.malformed,
                        },
                        "KEV catalogue count disagrees with its entry list",
                    );
                }

                const previous = await repository.getState();
                const result = await repository.apply(catalog.entries, {
                    minEntries: config.minEntriesToApply,
                });

                if (hooks.onNewlyListed && result.newlyListed.length > 0) {
                    try {
                        await hooks.onNewlyListed(
                            result.newlyListed,
                            previous ? { lastSyncedAt: previous.lastSyncedAt } : undefined,
                        );
                    } catch (hookErr) {
                        log.error(
                            { err: hookErr, newlyListed: result.newlyListed.length },
                            "KEV listing fan-out failed — columns applied, no events written",
                        );
                    }
                }

                await repository.recordSuccess({
                    catalogVersion: catalog.catalogVersion,
                    releasedAt: catalog.releasedAt,
                    entriesInCatalog: result.entriesInCatalog,
                    entriesMatched: result.entriesMatched,
                    entriesCleared: result.advisoriesCleared,
                });

                const durationMs = Date.now() - startedAt;
                log.info(
                    {
                        catalogVersion: catalog.catalogVersion,
                        ...result,
                        malformed: catalog.malformed,
                        durationMs,
                    },
                    "KEV sync complete",
                );

                return {
                    skipped: false,
                    catalogVersion: catalog.catalogVersion,
                    ...result,
                    malformedEntries: catalog.malformed,
                    durationMs,
                };
            } catch (err) {
                // Another process is applying this very catalogue; not a
                // failure, and not recorded as one.
                if (err instanceof SyncLockHeldError) {
                    log.info("KEV apply is running in another process (advisory lock held), skipping");
                    return { skipped: true, reason: "locked" };
                }
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err }, "KEV sync failed");
                await repository.recordFailure(message);
                throw err;
            }
        },
    };
}
