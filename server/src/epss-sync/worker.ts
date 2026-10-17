/**
 * The EPSS sync cycle: guard → download → parse → apply → record.
 */

import type { EpssSyncConfig } from "./config.js";
import type { EpssDownloader } from "./downloader.js";
import type { EpssRepository } from "./repository.js";
import { parseHeader, parseRow, type EpssRow } from "./parser.js";
import { isStateFresh } from "../db/single-row-state.js";
import { SyncLockHeldError } from "../lib/sync-lock.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("epss-sync");

export interface EpssSyncResult {
    skipped: boolean;
    reason?: string;
    scoreDate?: string | null;
    modelVersion?: string | null;
    rowsInFile?: number;
    cvesMatched?: number;
    cvesUnmatched?: number;
    advisoriesUpdated?: number;
    malformedRows?: number;
    durationMs?: number;
}

export function createEpssSyncWorker(config: EpssSyncConfig, downloader: EpssDownloader, repository: EpssRepository) {
    return {
        async runOnce(options?: { force?: boolean }): Promise<EpssSyncResult> {
            const startedAt = Date.now();

            if (
                await isStateFresh({
                    force: options?.force,
                    minSyncIntervalHours: config.minSyncIntervalHours,
                    getState: () => repository.getState(),
                    log,
                    message: "EPSS scores are fresh, skipping",
                })
            ) {
                return { skipped: true, reason: "fresh" };
            }

            await repository.markRunning();

            let scoreDate: string | null = null;
            let modelVersion: string | null = null;
            let malformed = 0;
            let sawHeader = false;

            // The parser is expressed as a generator over batches so the
            // staging insert consumes it lazily; nothing holds the 15 MB file.
            async function* batches(): AsyncGenerator<EpssRow[]> {
                let batch: EpssRow[] = [];
                for await (const line of downloader.streamLines()) {
                    if (!sawHeader && line.startsWith("#")) {
                        ({ scoreDate, modelVersion } = parseHeader(line));
                        sawHeader = true;
                        continue;
                    }
                    const row = parseRow(line);
                    if (!row) {
                        // The `cve,epss,percentile` column header and blank
                        // lines are legitimately unparseable; only count a line
                        // that looked like data.
                        if (line.trim() !== "" && !line.startsWith("cve,")) malformed++;
                        continue;
                    }
                    batch.push(row);
                    if (batch.length >= config.stagingBatchSize) {
                        yield batch;
                        batch = [];
                    }
                }
                if (batch.length > 0) yield batch;
            }

            try {
                const result = await repository.apply(batches(), {
                    batchSize: config.stagingBatchSize,
                    minRows: config.minRowsToApply,
                });

                await repository.recordSuccess({
                    scoreDate,
                    rowsInFile: result.rowsInFile,
                    rowsMatched: result.cvesMatched,
                    rowsUnmatched: result.cvesUnmatched,
                });

                const durationMs = Date.now() - startedAt;
                log.info(
                    {
                        scoreDate,
                        modelVersion,
                        rowsInFile: result.rowsInFile,
                        cvesMatched: result.cvesMatched,
                        cvesUnmatched: result.cvesUnmatched,
                        advisoriesUpdated: result.advisoriesUpdated,
                        malformed,
                        durationMs,
                    },
                    "EPSS sync complete",
                );

                return {
                    skipped: false,
                    scoreDate,
                    modelVersion,
                    rowsInFile: result.rowsInFile,
                    cvesMatched: result.cvesMatched,
                    cvesUnmatched: result.cvesUnmatched,
                    advisoriesUpdated: result.advisoriesUpdated,
                    malformedRows: malformed,
                    durationMs,
                };
            } catch (err) {
                // Another process is applying this very feed. Not a failure
                // and not recorded as one: the state row would otherwise
                // carry a "last error" for a run that is finishing elsewhere.
                if (err instanceof SyncLockHeldError) {
                    log.info("EPSS apply is running in another process (advisory lock held), skipping");
                    return { skipped: true, reason: "locked" };
                }
                const message = err instanceof Error ? err.message : String(err);
                log.error({ err }, "EPSS sync failed");
                await repository.recordFailure(message);
                throw err;
            }
        },
    };
}
