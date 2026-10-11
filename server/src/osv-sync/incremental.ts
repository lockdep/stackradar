import { randomUUID } from "node:crypto";
import type { SyncPhaseDeps, SyncCycleResult } from "./types.js";
import type { NewVulnerability, NewVulnerabilityAffectedPackage } from "../db/schema/vulnerabilities.js";
import type { NewOsvSyncFailure } from "../db/schema/osv-mirror.js";
import {
    scanModifiedCsv,
    updateCutoff,
    filterUpdateCandidates,
    parseOsvJson,
    extractAffectedPackages,
    convertOsvRecordToVulnerability,
    type ModifiedEntry,
    type ParsedOsvRecord,
} from "./parser.js";
import { ZipRecordConsumerError } from "./zip-processor.js";
import { fillInheritedSeverity } from "./severity-fill.js";
import { formatOsvValidationErrors } from "../validators/osv.validator.js";
import { vulnerabilityMirrorRepository } from "../repositories/index.js";
import { createLogger } from "../lib/logger.js";
import { persistRun, extractSyncError, SyncCounters } from "./sync-utils.js";

const log = createLogger("osv-sync:incremental");

/**
 * Cap on the human-readable error list carried in the run record. A burst day
 * with a systemic problem can fail tens of thousands of candidates, and
 * `osv_sync_runs.errors` is a jsonb column, not a log. The true count lives in
 * `parseFailures`, and every failure has its own row in `osv_sync_failures`.
 */
const MAX_REPORTED_ERRORS = 100;

function capWatermark(max: Date, minFailed: Date | null, floor: Date | null): Date {
    if (minFailed === null || minFailed > max) return max;
    const capped = new Date(minFailed.getTime() - 1);
    return floor !== null && capped < floor ? floor : capped;
}

/** Group candidates by the ecosystem directory their record lives under. */
function groupByEcosystemDir(candidates: ModifiedEntry[]): Map<string, ModifiedEntry[]> {
    const byDir = new Map<string, ModifiedEntry[]>();
    for (const candidate of candidates) {
        const existing = byDir.get(candidate.ecosystemDir);
        if (existing) existing.push(candidate);
        else byDir.set(candidate.ecosystemDir, [candidate]);
    }
    return byDir;
}

/**
 * One incremental sync cycle. The class exists to name the state a run
 * accumulates: the ingest paths and the batch flush all read and write the
 * same tallies, batches and watermark candidates, and as fields their
 * write/read order is the method call order — exactly the order the former
 * closures ran in.
 */
class IncrementalRun {
    private readonly config: SyncPhaseDeps["config"];
    private readonly stateManager: SyncPhaseDeps["stateManager"];
    private readonly downloader: SyncPhaseDeps["downloader"];
    private readonly zipProcessor: SyncPhaseDeps["zipProcessor"];
    private readonly affectedPkgRepository: SyncPhaseDeps["affectedPkgRepository"];
    private readonly failureRepository: SyncPhaseDeps["failureRepository"];
    private readonly runRepository: SyncPhaseDeps["runRepository"];

    private readonly syncRunId = randomUUID();
    private readonly startedAt = new Date();
    private readonly startTime = this.startedAt.getTime();
    private readonly errors: string[] = [];
    private readonly counters = new SyncCounters();

    private failureBatch: NewOsvSyncFailure[] = [];
    private vulnBatch: NewVulnerability[] = [];

    // Written by `acceptRecord`/`failCandidate` during ingest, read by the
    // chunk checkpoints and the final watermark computation after them.
    private maxProcessedTimestamp: Date | null = null;
    private minFailedTimestamp: Date | null = null;

    /** The watermark this run started from — the floor no checkpoint may fall below. */
    private lastModifiedApplied: Date | null = null;

    /**
     * The generation currently being served, set before either ingest path
     * runs. Incremental updates land in it: a bootstrap building the next one
     * cannot overlap (both hold the advisory lock), and scoping the writes
     * means an abandoned build's leftovers are never mistaken for rows this
     * sync should replace.
     */
    private generation = 0;

    private candidates: ModifiedEntry[] = [];

    constructor(deps: SyncPhaseDeps) {
        this.config = deps.config;
        this.stateManager = deps.stateManager;
        this.downloader = deps.downloader;
        this.zipProcessor = deps.zipProcessor;
        this.affectedPkgRepository = deps.affectedPkgRepository;
        this.failureRepository = deps.failureRepository;
        this.runRepository = deps.runRepository;
    }

    private async flushFailures(): Promise<void> {
        if (this.failureBatch.length === 0) return;
        const batch = this.failureBatch;
        this.failureBatch = [];
        await this.failureRepository.bulkInsert(batch);
    }

    /**
     * Queue a row for `osv_sync_failures`. Deliberately does *not* touch
     * `counters.parseFailures`: the table also holds `validation_warning` rows for
     * records that parsed and were ingested successfully, and counting those as
     * parse failures made the admin dashboard report tens of thousands of
     * "failures" for a mirror that had lost nothing. Only `failCandidate`,
     * which is the sole path a genuinely unusable record takes, increments it —
     * matching how bootstrap has always counted.
     */
    private recordFailure(f: Omit<NewOsvSyncFailure, "syncRunId" | "syncMode">): void {
        this.failureBatch.push({ syncRunId: this.syncRunId, syncMode: "incremental", ...f });
    }

    /**
     * Record that a candidate could not be applied. Its timestamp caps the
     * watermark, which is what makes the next run try it again.
     */
    private failCandidate(entry: ModifiedEntry, errorType: NewOsvSyncFailure["errorType"], message: string): void {
        if (this.errors.length < MAX_REPORTED_ERRORS) {
            this.errors.push(`Failed to apply ${entry.path}: ${message}`);
        }
        this.counters.parseFailures++;
        this.recordFailure({
            osvId: entry.vulnId || null,
            ecosystemDir: entry.ecosystemDir || null,
            sourcePath: entry.path,
            errorType,
            errorMessage: message,
        });
        if (!this.minFailedTimestamp || entry.modifiedTimestamp < this.minFailedTimestamp) {
            this.minFailedTimestamp = entry.modifiedTimestamp;
        }
    }

    /** Queue a parsed record for the next flush. Shared by both ingest paths. */
    private acceptRecord(record: ParsedOsvRecord, entry: ModifiedEntry): void {
        if (record.validationErrors.length > 0) {
            this.counters.schemaValidationWarnings++;
            this.recordFailure({
                osvId: record.id,
                ecosystemDir: entry.ecosystemDir || null,
                sourcePath: entry.path,
                errorType: "validation_warning",
                errorMessage: formatOsvValidationErrors(record.validationErrors),
            });
        }

        this.vulnBatch.push(convertOsvRecordToVulnerability(record));

        if (!this.maxProcessedTimestamp || record.modified > this.maxProcessedTimestamp) {
            this.maxProcessedTimestamp = record.modified;
        }
    }

    private async flushIncrementalBatch(): Promise<void> {
        if (this.vulnBatch.length === 0) return;

        // Capture and clear before the DB calls so the raw JSON objects
        // can be collected once the affected-package data is extracted.
        const batch = this.vulnBatch;
        this.vulnBatch = [];

        const upsert = await vulnerabilityMirrorRepository.bulkUpsertFromSync(batch);

        this.counters.inserted += upsert.inserted;
        this.counters.updated += upsert.updated;
        this.counters.unchanged += upsert.unchanged;
        this.counters.recordsProcessed += batch.length;

        // Only advisories whose content actually moved get their
        // affected-package rows rebuilt. Every overlap window re-downloads
        // records it already has; rewriting their rows was pure churn and
        // table bloat, and the old code could not tell the difference
        // because a filtered upsert returns nothing for an unchanged row.
        if (upsert.rows.length === 0) {
            await this.flushFailures();
            return;
        }

        // The upsert just restated these records' own severity; re-lend a
        // score to every record of their identities that has none.
        await fillInheritedSeverity({ vulnIds: upsert.rows.map((row) => row.vulnId) });

        const rawByVulnId = new Map(batch.map((v) => [v.vulnId, v.rawData as unknown]));
        const affectedPkgBatch: NewVulnerabilityAffectedPackage[] = [];
        const uuidBatch: string[] = [];

        for (const row of upsert.rows) {
            affectedPkgBatch.push(...extractAffectedPackages(row.id, rawByVulnId.get(row.vulnId)));
            uuidBatch.push(row.id);
        }

        // Guarded on the *vulnerability* count, not the row count: an
        // advisory that has just lost all its affected entries still needs
        // its old rows deleted, and skipping the call would leave them
        // behind as permanently stale candidates.
        const { inserted: pkgInserted } = await this.affectedPkgRepository.replaceForVulns(
            uuidBatch,
            affectedPkgBatch,
            this.generation,
        );
        this.counters.affectedPackagesExtracted += pkgInserted;

        await this.flushFailures();
    }

    /**
     * The steady-state path: one GET per candidate, in chunks, checkpointing
     * the watermark after each. Safe to checkpoint mid-run because
     * candidates are sorted oldest-first, so everything below the checkpoint
     * has been applied.
     */
    private async ingestByRecord(): Promise<void> {
        const totalChunks = Math.ceil(this.candidates.length / this.config.batchSize);

        for (let chunkStart = 0; chunkStart < this.candidates.length; chunkStart += this.config.batchSize) {
            const chunkIndex = Math.floor(chunkStart / this.config.batchSize) + 1;
            const chunk = this.candidates.slice(chunkStart, chunkStart + this.config.batchSize);
            const downloadResults = await this.downloader.downloadMany(
                chunk,
                (entry) => `${this.config.osvStorageBaseUrl}/${entry.ecosystemDir}/${entry.vulnId}.json`,
                this.config.maxParallelDownloads,
            );

            for (const [entry, result] of downloadResults) {
                if (result instanceof Error) {
                    this.failCandidate(entry, "download_error", result.message);
                    continue;
                }

                try {
                    this.acceptRecord(
                        parseOsvJson(result.data, entry.ecosystemDir, this.downloader.computeSha256),
                        entry,
                    );
                } catch (parseError) {
                    this.failCandidate(
                        entry,
                        "parse_error",
                        parseError instanceof Error ? parseError.message : String(parseError),
                    );
                }
            }

            // Drop raw Buffer references before the DB flush so both don't peak simultaneously.
            downloadResults.clear();

            await this.flushIncrementalBatch();

            if (this.maxProcessedTimestamp !== null) {
                const chunkCheckpoint = capWatermark(
                    this.maxProcessedTimestamp,
                    this.minFailedTimestamp,
                    this.lastModifiedApplied,
                );
                await this.stateManager.updateState({ lastModifiedApplied: chunkCheckpoint });
                const mem = process.memoryUsage();
                log.info(
                    {
                        chunkIndex,
                        totalChunks,
                        recordsProcessed: this.counters.recordsProcessed,
                        checkpoint: chunkCheckpoint,
                        memHeapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                        memRssMb: Math.round(mem.rss / 1024 / 1024),
                    },
                    "Incremental sync chunk checkpoint",
                );
            }
        }
    }

    /**
     * The burst path: pull each ecosystem's archive once instead of issuing
     * tens of thousands of individual GETs at concurrency 8. A bulk
     * republish (MinimOS, Chainguard, Ubuntu) or one missed window puts
     * ~43,000 candidates in a single run, which is ~200x the steady state.
     *
     * No mid-run checkpointing here: ZIP entry order has nothing to do with
     * `modified`, so a watermark advanced part-way through would skip
     * records this run has not reached. A death mid-archive costs the run,
     * not correctness.
     */
    private async ingestByArchive(): Promise<void> {
        const byDir = groupByEcosystemDir(this.candidates);
        log.info(
            {
                candidateCount: this.candidates.length,
                ecosystemDirs: byDir.size,
                threshold: this.config.bulkFallbackThreshold,
            },
            "Candidate count over the bulk threshold — using per-ecosystem archives",
        );

        for (const [ecosystemDir, dirCandidates] of byDir) {
            const wanted = new Map(dirCandidates.map((entry) => [entry.vulnId, entry]));
            const seen = new Set<string>();
            const url = `${this.config.osvStorageBaseUrl}/${ecosystemDir}/all.zip`;

            try {
                const result = await this.zipProcessor.processZip(
                    url,
                    async (record, zipEntry) => {
                        const candidate = wanted.get(zipEntry.vulnId);
                        if (!candidate) return; // filtered out already; belt and braces
                        seen.add(zipEntry.vulnId);

                        // The archive is a periodic snapshot and can lag the
                        // CSV. Applying a stale copy would advance the
                        // watermark past a change we never actually took, and
                        // nothing below the watermark is ever revisited — so
                        // treat it as a failure and let the next run retry.
                        if (record.modified < candidate.modifiedTimestamp) {
                            this.failCandidate(
                                candidate,
                                "download_error",
                                `Archive copy is stale (modified ${record.modified.toISOString()}, ` +
                                    `expected ${candidate.modifiedTimestamp.toISOString()})`,
                            );
                            return;
                        }

                        this.acceptRecord(record, candidate);

                        if (this.vulnBatch.length >= this.config.batchSize) {
                            await this.flushIncrementalBatch();
                            // Yield so V8 can reclaim the flushed batch before
                            // the next one builds up in old space.
                            await new Promise<void>((resolve) => setImmediate(resolve));
                        }
                    },
                    {
                        filter: (zipEntry) => wanted.has(zipEntry.vulnId),
                        onError: (failure) => {
                            const candidate = failure.osvId ? wanted.get(failure.osvId) : undefined;
                            if (!candidate) return;
                            seen.add(candidate.vulnId);
                            this.failCandidate(candidate, "parse_error", failure.errorMessage);
                        },
                    },
                );

                await this.flushIncrementalBatch();

                log.info(
                    {
                        ecosystemDir,
                        wanted: wanted.size,
                        found: seen.size,
                        processed: result.processedCount,
                    },
                    "Processed ecosystem archive",
                );
            } catch (archiveError) {
                // A write failure is ours and must take the run down; a bad
                // archive is one ecosystem's problem, and the rest of the
                // candidates are still worth applying.
                if (archiveError instanceof ZipRecordConsumerError) throw archiveError;

                const message = archiveError instanceof Error ? archiveError.message : String(archiveError);
                log.error({ ecosystemDir, url, error: message }, "Ecosystem archive failed");
            }

            // Whatever the archive did not carry — because it lags the CSV,
            // because the download failed, or because the record moved
            // directories — is a failure, so the watermark stays behind it.
            for (const [vulnId, candidate] of wanted) {
                if (!seen.has(vulnId)) {
                    this.failCandidate(candidate, "download_error", `Not present in ${ecosystemDir} archive`);
                }
            }
        }

        await this.flushIncrementalBatch();
    }

    async run(): Promise<SyncCycleResult> {
        log.info({ syncRunId: this.syncRunId }, "Starting incremental sync");
        await this.stateManager.setSyncStatus("incremental");

        try {
            const state = await this.stateManager.getState();
            this.lastModifiedApplied = state.lastModifiedApplied;

            // Streamed and cut off at the watermark rather than parsed whole: the
            // file is 896k lines back to 2002, sorted newest-first, and a typical
            // hour changes ~220 of them.
            const cutoff = updateCutoff(this.lastModifiedApplied, this.config.overlapWindowMinutes);
            const scan = await scanModifiedCsv(this.downloader.streamLines(this.config.osvModifiedCsvUrl), cutoff);

            if (scan.linesParsed === 0) {
                log.info("No entries in modified_id.csv");
                await this.stateManager.setSyncStatus("idle");
                const emptyResult = this.counters.toResult({
                    success: true,
                    mode: "incremental",
                    syncRunId: this.syncRunId,
                    errors: [],
                    durationMs: Date.now() - this.startTime,
                    lagSeconds: undefined,
                });
                await persistRun(this.runRepository, emptyResult, this.startedAt);
                return emptyResult;
            }

            // The newest line in the file. Correct whether or not the scan stopped
            // early, because it stops at the *old* end of a newest-first file.
            const maxModifiedSeen = scan.maxModifiedSeen!;

            // A scoped mirror (`OSV_ECOSYSTEMS`) ignores entries under other
            // directories — before the cross-listing dedupe, so an advisory
            // listed under both an in-scope and an out-of-scope directory is
            // kept through its in-scope path. Skipped entries are not
            // failures: the watermark moves past them, which is the point.
            const scope = this.config.ecosystems;
            const inScope = scope === null ? null : new Set(scope);
            const entries = inScope ? scan.entries.filter((entry) => inScope.has(entry.ecosystemDir)) : scan.entries;
            const outOfScope = scan.entries.length - entries.length;

            const { candidates, deduplications } = filterUpdateCandidates(
                entries,
                this.lastModifiedApplied,
                this.config.overlapWindowMinutes,
            );
            this.candidates = candidates;
            this.counters.deduplications = deduplications;

            if (deduplications.length > 0) {
                log.info({ deduplicatedCount: deduplications.length }, "Deduplicated cross-listed vulnerabilities");
            }

            log.info(
                {
                    linesParsed: scan.linesParsed,
                    stoppedEarly: scan.stoppedEarly,
                    orderingViolated: scan.orderingViolated,
                    candidateCount: candidates.length,
                    deduplicatedCandidates: deduplications.length,
                    ...(scope !== null && { outOfScope }),
                    lastModifiedApplied: this.lastModifiedApplied,
                    maxModifiedSeen,
                },
                "Processing update candidates",
            );

            if (candidates.length === 0) {
                await this.stateManager.recordSuccessfulSync({
                    pollTime: new Date(),
                    maxModifiedSeen,
                    maxModifiedApplied: this.lastModifiedApplied!,
                });
                await this.stateManager.setSyncStatus("idle");

                const noCandidatesResult = this.counters.toResult({
                    success: true,
                    mode: "incremental",
                    syncRunId: this.syncRunId,
                    errors: [],
                    durationMs: Date.now() - this.startTime,
                    lagSeconds: 0,
                });
                await persistRun(this.runRepository, noCandidatesResult, this.startedAt);
                return noCandidatesResult;
            }

            this.generation = await this.affectedPkgRepository.getCurrentGeneration();

            if (candidates.length >= this.config.bulkFallbackThreshold) {
                await this.ingestByArchive();
            } else {
                await this.ingestByRecord();
            }

            await this.flushFailures();

            const baseMax = this.maxProcessedTimestamp ?? this.lastModifiedApplied!;
            const effectiveMaxApplied = capWatermark(baseMax, this.minFailedTimestamp, this.lastModifiedApplied);

            if (this.minFailedTimestamp !== null && this.minFailedTimestamp <= baseMax) {
                log.warn(
                    { minFailedTimestamp: this.minFailedTimestamp, effectiveMaxApplied },
                    "Watermark capped due to failures — affected entries will be retried next sync",
                );
            }

            await this.stateManager.recordSuccessfulSync({
                pollTime: new Date(),
                maxModifiedSeen,
                maxModifiedApplied: effectiveMaxApplied,
            });
            await this.stateManager.setSyncStatus("idle");

            const lagSeconds = await this.stateManager.getLagSeconds();

            if (lagSeconds !== null && lagSeconds > this.config.lagWarningThresholdHours * 3600) {
                log.warn(
                    {
                        lagSeconds,
                        lagHours: Math.round(lagSeconds / 3600),
                        threshold: this.config.lagWarningThresholdHours,
                    },
                    "Sync lag exceeds warning threshold",
                );
            }

            const durationMs = Date.now() - this.startTime;
            log.info(
                {
                    syncRunId: this.syncRunId,
                    recordsProcessed: this.counters.recordsProcessed,
                    inserted: this.counters.inserted,
                    updated: this.counters.updated,
                    unchanged: this.counters.unchanged,
                    affectedPackagesExtracted: this.counters.affectedPackagesExtracted,
                    schemaValidationWarnings: this.counters.schemaValidationWarnings,
                    parseFailures: this.counters.parseFailures,
                    deduplicatedCandidates: this.counters.deduplications.length,
                    errorCount: this.errors.length,
                    lagSeconds,
                    durationMs,
                },
                "Incremental sync complete",
            );

            const incrementalSuccess = this.counters.toResult({
                success: true,
                mode: "incremental",
                syncRunId: this.syncRunId,
                errors: this.errors,
                durationMs,
                lagSeconds: lagSeconds ?? undefined,
            });
            await persistRun(this.runRepository, incrementalSuccess, this.startedAt);
            return incrementalSuccess;
        } catch (error) {
            const { errorMessage, loggableError } = extractSyncError(error);
            log.error({ error: loggableError, syncRunId: this.syncRunId }, "Incremental sync failed");
            await this.stateManager.recordFailure(errorMessage);
            await this.stateManager.setSyncStatus("idle");
            await this.flushFailures();

            const incrementalFail = this.counters.toResult({
                success: false,
                mode: "incremental",
                syncRunId: this.syncRunId,
                errors: [errorMessage, ...this.errors],
                durationMs: Date.now() - this.startTime,
                lagSeconds: undefined,
            });
            await persistRun(this.runRepository, incrementalFail, this.startedAt);
            return incrementalFail;
        }
    }
}

export async function runIncremental(deps: SyncPhaseDeps): Promise<SyncCycleResult> {
    return new IncrementalRun(deps).run();
}
