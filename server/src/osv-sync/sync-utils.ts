import type { DeduplicationInfo, SyncCycleResult } from "./types.js";
import type { OsvSyncRunRepository } from "./run-repository.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("osv-sync");

/**
 * The mutable tallies a sync run accumulates, and the single place they are
 * assembled into a `SyncCycleResult`. Everything a literal used to spell out
 * that is *not* a tally — success, mode, the error list, timing — stays an
 * explicit argument, so each return site still states what makes it different.
 */
export class SyncCounters {
    recordsProcessed = 0;
    inserted = 0;
    updated = 0;
    unchanged = 0;
    affectedPackagesExtracted = 0;
    schemaValidationWarnings = 0;
    parseFailures = 0;
    deduplications: DeduplicationInfo[] = [];

    toResult(args: {
        success: boolean;
        mode: "initialization" | "incremental";
        syncRunId: string;
        errors: string[];
        durationMs: number;
        lagSeconds: number | undefined;
    }): SyncCycleResult {
        return {
            success: args.success,
            mode: args.mode,
            syncRunId: args.syncRunId,
            recordsProcessed: this.recordsProcessed,
            inserted: this.inserted,
            updated: this.updated,
            unchanged: this.unchanged,
            affectedPackagesExtracted: this.affectedPackagesExtracted,
            schemaValidationWarnings: this.schemaValidationWarnings,
            parseFailures: this.parseFailures,
            deduplicatedCandidates: this.deduplications.length,
            deduplications: this.deduplications,
            errors: args.errors,
            durationMs: args.durationMs,
            lagSeconds: args.lagSeconds,
        };
    }
}

export async function persistRun(
    runRepository: OsvSyncRunRepository,
    result: SyncCycleResult,
    startedAt: Date,
): Promise<void> {
    try {
        await runRepository.insert({
            id: result.syncRunId,
            mode: result.mode,
            success: result.success,
            recordsProcessed: result.recordsProcessed,
            inserted: result.inserted,
            updated: result.updated,
            unchanged: result.unchanged,
            affectedPackagesExtracted: result.affectedPackagesExtracted,
            schemaValidationWarnings: result.schemaValidationWarnings,
            parseFailures: result.parseFailures,
            deduplicatedCandidates: result.deduplicatedCandidates,
            durationMs: result.durationMs,
            lagSeconds: result.lagSeconds ?? null,
            errors: result.errors.length > 0 ? result.errors : null,
            startedAt,
        });
    } catch (err) {
        log.warn({ err }, "Failed to persist sync run record");
    }
}

export function extractSyncError(error: unknown): {
    errorMessage: string;
    loggableError: Record<string, unknown>;
} {
    // Drizzle wraps the pg error in DrizzleQueryError — extract the real cause.
    const cause = (error as { cause?: unknown }).cause;
    const pgErr = (cause ?? error) as Record<string, unknown>;
    const errorMessage = (typeof pgErr.message === "string" ? pgErr.message : String(error)).slice(0, 2000);
    const loggableError = {
        message: errorMessage,
        code: pgErr.code,
        detail: pgErr.detail,
        column: pgErr.column,
        constraint: pgErr.constraint,
    };
    return { errorMessage, loggableError };
}
