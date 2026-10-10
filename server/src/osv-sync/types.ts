import type { OsvSyncConfig } from "./config.js";
import type { SyncStateManager } from "./state.js";
import type { OsvDownloader } from "./downloader.js";
import type { ZipProcessor } from "./zip-processor.js";
import type { OsvAffectedPackageRepository } from "./affected-package-repository.js";
import type { OsvSyncFailureRepository } from "./failure-repository.js";
import type { OsvSyncRunRepository } from "./run-repository.js";

export interface DeduplicationInfo {
    vulnId: string;
    ecosystemDirs: string[];
}

export interface SyncCycleResult {
    success: boolean;
    /**
     * The run declined to start rather than failing: another instance holds the
     * advisory lock. Benign — a manual run alongside the CronJob is the usual
     * cause — so callers must not treat it as an error, or an overlap burns the
     * Job's `backoffLimit` and pages someone.
     */
    skipped?: boolean;
    /**
     * There was nothing to do: `bootstrapIfNeeded()` found a mirror that
     * already has a complete generation. Distinct from `skipped`, which means
     * another instance holds the lock — conflating them would make the
     * twice-daily no-op indistinguishable from real contention in the logs.
     */
    noop?: boolean;
    mode: "initialization" | "incremental";
    /** UUID identifying this sync run (use to query osv_sync_failures) */
    syncRunId: string;
    recordsProcessed: number;
    inserted: number;
    updated: number;
    unchanged: number;
    /** Affected package rows extracted and inserted */
    affectedPackagesExtracted: number;
    /** Records that had schema validation warnings (still processed) */
    schemaValidationWarnings: number;
    /** Records that failed to parse or download (persisted to osv_sync_failures) */
    parseFailures: number;
    /** Number of duplicate vulnIds removed from candidates */
    deduplicatedCandidates: number;
    /** Details of deduplicated entries (vulnId + collapsed ecosystem dirs) */
    deduplications: DeduplicationInfo[];
    errors: string[];
    durationMs: number;
    lagSeconds: number | undefined;
}

export interface SyncPhaseDeps {
    config: OsvSyncConfig;
    stateManager: SyncStateManager;
    downloader: OsvDownloader;
    zipProcessor: ZipProcessor;
    affectedPkgRepository: OsvAffectedPackageRepository;
    failureRepository: OsvSyncFailureRepository;
    runRepository: OsvSyncRunRepository;
}
