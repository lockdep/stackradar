import { randomUUID } from "node:crypto";
import type { SyncPhaseDeps, SyncCycleResult } from "./types.js";
import type { OsvSyncConfig } from "./config.js";
import type { NewVulnerability, NewVulnerabilityAffectedPackage } from "../db/schema/vulnerabilities.js";
import type { NewOsvSyncFailure } from "../db/schema/osv-mirror.js";
import type { ZipProcessFailure, ZipProcessorResult } from "./zip-processor.js";
import { extractAffectedPackages, convertOsvRecordToVulnerability } from "./parser.js";
import { formatOsvValidationErrors } from "../validators/osv.validator.js";
import { vulnerabilityMirrorRepository } from "../repositories/index.js";
import { createLogger } from "../lib/logger.js";
import { persistRun, extractSyncError, SyncCounters } from "./sync-utils.js";
import { fillInheritedSeverity } from "./severity-fill.js";
import { ecosystemArchiveUrl, ecosystemsListUrl, parseEcosystemsTxt } from "./ecosystems.js";
import { createBootstrapProgressReporter, type BootstrapProgressReporter } from "./bootstrap-progress.js";

const log = createLogger("osv-sync:bootstrap");

/**
 * Decide whether a finished import is fit to become the live mirror.
 * Returns null when it is, or the reason it is not.
 *
 * Two thresholds rather than one: a small absolute number of unparseable
 * records is normal for a corpus this size and should not block a rebuild
 * regardless of how it divides, while a proportion above the ratio means
 * something systemic went wrong (a schema change, a truncated download) and the
 * result must not replace a mirror that is currently correct.
 */
function assessRebuild(result: ZipProcessorResult, config: OsvSyncConfig): string | null {
    if (result.processedCount === 0) {
        return "Rebuild produced no records";
    }

    if (!result.maxModifiedTimestamp) {
        return "Rebuild produced no watermark (no record carried a modified timestamp)";
    }

    const attempted = result.processedCount + result.errorCount;
    const ratio = result.errorCount / attempted;

    if (result.errorCount > config.bootstrapMaxFailedEntries && ratio > config.bootstrapMaxFailedEntryRatio) {
        return (
            `Rebuild failed on ${result.errorCount} of ${attempted} entries ` +
            `(${(ratio * 100).toFixed(2)}%), above the tolerated ` +
            `${config.bootstrapMaxFailedEntries} entries / ` +
            `${(config.bootstrapMaxFailedEntryRatio * 100).toFixed(2)}%`
        );
    }

    return null;
}

/**
 * Drop the rows a failed or rejected rebuild wrote. Best-effort: the run has
 * already failed, and leaving orphan rows behind costs disk, not correctness —
 * they are invisible to readers and the next rebuild takes a fresh generation
 * number. Losing the real error to a cleanup error would cost a diagnosis.
 */
async function discardBuild(
    affectedPkgRepository: SyncPhaseDeps["affectedPkgRepository"],
    buildGeneration: number,
    liveGeneration: number,
): Promise<void> {
    try {
        await affectedPkgRepository.discardGeneration(buildGeneration);
    } catch (cleanupError) {
        log.warn(
            { buildGeneration, liveGeneration, error: cleanupError },
            "Failed to discard the partial rebuild — rows remain but are not readable",
        );
    }
}

function memRssMb(): number {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

type RecordConsumer = Parameters<SyncPhaseDeps["zipProcessor"]["processZip"]>[1];
type ZipOptions = NonNullable<Parameters<SyncPhaseDeps["zipProcessor"]["processZip"]>[2]>;

/**
 * The scoped rebuild (`OSV_ECOSYSTEMS`): one `<dir>/all.zip` per configured
 * ecosystem instead of the global archive, folded into one result so the
 * caller judges and publishes it exactly as it would a single archive.
 *
 * Two things the global archive never had to think about:
 *
 * - **Names are checked before anything is downloaded.** A directory that
 *   does not exist is a 404 the downloader would retry and then throw on,
 *   but a name that exists under a different spelling (`RedHat`, `Alma`)
 *   is the dangerous case: the bucket's `ecosystems.txt` is the authority,
 *   and a configured name it does not list fails the run with the list in
 *   the message. A bootstrap visits each record once and the incremental
 *   sync never revisits anything below the watermark, so a silently skipped
 *   ecosystem would be a permanent hole reported as a healthy mirror.
 * - **Cross-listed advisories are taken once.** A GHSA that affects an npm
 *   package and a Maven one is byte-identical under both directories; the
 *   global archive is flat and carries it once, the per-ecosystem archives
 *   each carry a copy. The upsert would absorb the second copy, but
 *   `extractAffectedPackages` would then write its rows into the build
 *   generation twice. Entries already seen are filtered by path, before
 *   they are inflated.
 *
 * A failed archive fails the run, for the same reason as the name check.
 */
async function importEcosystemArchives(
    deps: Pick<SyncPhaseDeps, "config" | "downloader" | "zipProcessor">,
    scope: readonly string[],
    onRecord: RecordConsumer,
    options: Pick<ZipOptions, "batchSize" | "onError" | "onProgress" | "onDownloadProgress">,
    progress: BootstrapProgressReporter,
): Promise<ZipProcessorResult> {
    const { config, downloader, zipProcessor } = deps;

    const listUrl = ecosystemsListUrl(config.osvStorageBaseUrl);
    const published = parseEcosystemsTxt((await downloader.download(listUrl)).data.toString("utf8"));
    const unknown = scope.filter((name) => !published.has(name));
    if (unknown.length > 0) {
        throw new Error(
            `OSV_ECOSYSTEMS names ${unknown.length} ecosystem(s) OSV does not publish: ` +
                `${unknown.join(", ")}. Directory names are case-sensitive; the list is at ${listUrl}`,
        );
    }

    const seen = new Set<string>();
    const total: ZipProcessorResult = { processedCount: 0, errorCount: 0, maxModifiedTimestamp: null, errors: [] };

    for (const [index, ecosystemDir] of scope.entries()) {
        const url = ecosystemArchiveUrl(config.osvStorageBaseUrl, ecosystemDir);
        const startedAt = Date.now();
        log.info({ ecosystemDir, url, archive: `${index + 1}/${scope.length}` }, "Importing ecosystem archive");
        progress.startArchive({ index: index + 1, count: scope.length, ecosystem: ecosystemDir });

        const result = await zipProcessor.processZip(
            url,
            async (record, entry) => {
                seen.add(entry.vulnId);
                await onRecord(record, entry);
            },
            {
                ...options,
                // Cheap, and applied before the entry is inflated: a record
                // another ecosystem's archive already delivered is skipped
                // by its path alone.
                filter: (entry) => !seen.has(entry.vulnId),
            },
        );

        progress.finishArchive(result.processedCount);
        total.processedCount += result.processedCount;
        total.errorCount += result.errorCount;
        total.errors.push(...result.errors);
        if (
            result.maxModifiedTimestamp &&
            (!total.maxModifiedTimestamp || result.maxModifiedTimestamp > total.maxModifiedTimestamp)
        ) {
            total.maxModifiedTimestamp = result.maxModifiedTimestamp;
        }

        log.info(
            {
                ecosystemDir,
                processed: result.processedCount,
                failedEntries: result.errorCount,
                cumulativeProcessed: total.processedCount,
                durationMs: Date.now() - startedAt,
                memRssMb: memRssMb(),
            },
            "Imported ecosystem archive",
        );
    }

    total.errors = total.errors.slice(0, 100);
    return total;
}

export async function runBootstrap(deps: SyncPhaseDeps): Promise<SyncCycleResult> {
    const { config, stateManager, zipProcessor, affectedPkgRepository, failureRepository, runRepository } = deps;

    const syncRunId = randomUUID();
    const startedAt = new Date();
    const startTime = startedAt.getTime();
    const errors: string[] = [];
    const counters = new SyncCounters();

    // The rebuild is written under the next generation while the live one keeps
    // serving matches; nothing is deleted until the whole import has succeeded.
    const liveGeneration = await affectedPkgRepository.getCurrentGeneration();
    const buildGeneration = liveGeneration + 1;

    // `null` is the whole corpus from the global archive; a list is one
    // archive per ecosystem (`importEcosystemArchives`), the community
    // edition's default.
    const scope = config.ecosystems;

    log.info(
        { syncRunId, liveGeneration, buildGeneration, ecosystems: scope ?? "all" },
        scope === null
            ? "Starting full initialization from all.zip"
            : `Starting full initialization from ${scope.length} per-ecosystem archives`,
    );

    // Still reported for observability — but it no longer gates reads, because
    // with the generation swap the live rows are never removed under a reader.
    await stateManager.setSyncStatus("full_refresh");
    const progress = createBootstrapProgressReporter(stateManager);

    // A previous attempt that died before its cleanup ran left rows under this
    // same number (the build generation is always live + 1, so retries reuse
    // it). Clearing first is what keeps a retry a clean rebuild rather than a
    // merge of two partial ones.
    await discardBuild(affectedPkgRepository, buildGeneration, liveGeneration);

    let vulnBatch: NewVulnerability[] = [];
    let failureBatch: NewOsvSyncFailure[] = [];

    const flushFailures = async () => {
        if (failureBatch.length === 0) return;
        // Capture and clear before the INSERT so a failed INSERT doesn't leave
        // records stranded in the batch to be retried (and compounded) forever.
        const batch = failureBatch;
        failureBatch = [];
        await failureRepository.bulkInsert(batch);
    };

    const AFFECTED_PKG_FLUSH_SIZE = 2000;

    const flushBatch = async () => {
        if (vulnBatch.length === 0) return;

        // Capture and clear immediately so a DB error cannot cause unbounded growth:
        // if the upsert throws, vulnBatch is already empty and the next entry starts
        // a fresh batch instead of retrying an ever-growing one.
        const batch = vulnBatch;
        vulnBatch = [];

        // `includeUnchanged`, unlike the incremental path: a rebuild writes the
        // affected-package rows of *every* advisory into the new generation, so
        // it needs the UUID of an advisory whose content happens not to have
        // moved since the last rebuild just as much as a changed one. Skipping
        // those would publish a generation missing most of the corpus.
        const upsert = await vulnerabilityMirrorRepository.bulkUpsertFromSync(batch, {
            includeUnchanged: true,
        });
        const uuidMap = new Map(upsert.rows.map((r) => [r.vulnId, r.id]));

        counters.inserted += upsert.inserted;
        counters.updated += upsert.updated;
        counters.unchanged += upsert.unchanged;
        counters.recordsProcessed += batch.length;

        // Extract and insert affected packages in bounded chunks to avoid accumulating
        // a large in-memory array when some records have many affected packages.
        let affectedPkgChunk: NewVulnerabilityAffectedPackage[] = [];
        for (const vuln of batch) {
            const uuid = uuidMap.get(vuln.vulnId);
            if (!uuid) continue;
            const pkgs = extractAffectedPackages(uuid, vuln.rawData as unknown);
            affectedPkgChunk.push(...pkgs);

            if (affectedPkgChunk.length >= AFFECTED_PKG_FLUSH_SIZE) {
                const pkgInserted = await affectedPkgRepository.bulkInsert(affectedPkgChunk, buildGeneration);
                counters.affectedPackagesExtracted += pkgInserted;
                affectedPkgChunk = [];
            }
        }

        if (affectedPkgChunk.length > 0) {
            const pkgInserted = await affectedPkgRepository.bulkInsert(affectedPkgChunk, buildGeneration);
            counters.affectedPackagesExtracted += pkgInserted;
        }

        await flushFailures();
    };

    try {
        const onRecord: RecordConsumer = async (record, entry) => {
            vulnBatch.push(convertOsvRecordToVulnerability(record));

            if (record.validationErrors.length > 0) {
                counters.schemaValidationWarnings++;
                failureBatch.push({
                    syncRunId,
                    syncMode: "initialization",
                    osvId: record.id,
                    ecosystemDir: entry.ecosystemDir || null,
                    sourcePath: entry.path,
                    errorType: "validation_warning",
                    errorMessage: formatOsvValidationErrors(record.validationErrors),
                });
            }

            if (vulnBatch.length >= config.batchSize) {
                await flushBatch();
                // Yield to the event loop so V8 GC can reclaim the flushed batch
                // before the next one starts building up in old space.
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        };

        const zipOptions = {
            batchSize: config.batchSize,
            onProgress: (processed: number, total?: number) => {
                // RSS alongside progress: this is the number the monolith
                // server pod's memory limit has to cover.
                log.info(
                    { processed, total, affectedPkgs: counters.affectedPackagesExtracted, memRssMb: memRssMb() },
                    "Initialization progress",
                );
                progress.imported(processed, total);
            },
            onDownloadProgress: (bytesReceived: number, contentLength: number | undefined) => {
                progress.downloaded(bytesReceived, contentLength);
            },
            onError: (failure: ZipProcessFailure) => {
                counters.parseFailures++;
                failureBatch.push({
                    syncRunId,
                    syncMode: "initialization",
                    osvId: failure.osvId,
                    ecosystemDir: failure.ecosystemDir,
                    sourcePath: failure.sourcePath,
                    errorType: failure.errorType,
                    errorMessage: failure.errorMessage,
                });
            },
        };

        let result: ZipProcessorResult;
        if (scope === null) {
            progress.startArchive({ index: 1, count: 1, ecosystem: null });
            result = await zipProcessor.processZip(config.osvAllZipUrl, onRecord, zipOptions);
            progress.finishArchive(result.processedCount);
        } else {
            result = await importEcosystemArchives(deps, scope, onRecord, zipOptions, progress);
        }

        await flushBatch();
        await flushFailures();

        // Settled before anything clears the column: a throttled snapshot
        // landing after `markInitialized` would leave a finished run
        // reported as still publishing.
        progress.publishing();
        await progress.settle();

        errors.push(...result.errors);

        // A rebuild is only allowed to become the live mirror if it is
        // *complete enough*. Individual unparseable OSV records are expected and
        // tolerated; a run that lost a meaningful share of the corpus is not,
        // because publishing it would bake the gap in permanently — incremental
        // sync never revisits a record whose `modified` is below the watermark.
        const rejection = assessRebuild(result, config);

        if (rejection) {
            errors.push(rejection);
            log.error(
                {
                    syncRunId,
                    buildGeneration,
                    processed: result.processedCount,
                    failedEntries: result.errorCount,
                    reason: rejection,
                },
                "Initialization rejected — keeping the previous generation live",
            );
            await discardBuild(affectedPkgRepository, buildGeneration, liveGeneration);
            await stateManager.recordFailure(rejection);
            await stateManager.setSyncStatus("idle");

            const rejectedResult = counters.toResult({
                success: false,
                mode: "initialization",
                syncRunId,
                errors,
                durationMs: Date.now() - startTime,
                lagSeconds: undefined,
            });
            await persistRun(runRepository, rejectedResult, startedAt);
            return rejectedResult;
        }

        // Publish: pointer move and removal of the superseded generation, atomically.
        const { deleted } = await affectedPkgRepository.promoteGeneration(buildGeneration);
        await stateManager.markInitialized(result.maxModifiedTimestamp!, scope);
        // One pass over the whole mirror rather than one per batch: every
        // record was just restated, and an identity's lender may have been in
        // any batch.
        await fillInheritedSeverity("all");

        const durationMs = Date.now() - startTime;
        log.info(
            {
                syncRunId,
                recordsProcessed: counters.recordsProcessed,
                affectedPackagesExtracted: counters.affectedPackagesExtracted,
                generation: buildGeneration,
                ecosystems: scope ?? "all",
                supersededRowsDeleted: deleted,
                schemaValidationWarnings: counters.schemaValidationWarnings,
                parseFailures: counters.parseFailures,
                errorCount: errors.length,
                durationMs,
            },
            "Initialization complete",
        );

        const successResult = counters.toResult({
            success: true,
            mode: "initialization",
            syncRunId,
            errors,
            durationMs,
            lagSeconds: undefined,
        });
        await persistRun(runRepository, successResult, startedAt);
        return successResult;
    } catch (error) {
        const { errorMessage, loggableError } = extractSyncError(error);
        log.error({ error: loggableError, syncRunId, buildGeneration }, "Initialization failed");
        await progress.settle();
        // The live generation was never touched, so matching is unaffected; all
        // that is left behind is the partial build, which is dropped here.
        await discardBuild(affectedPkgRepository, buildGeneration, liveGeneration);
        await stateManager.recordFailure(errorMessage);
        await stateManager.setSyncStatus("idle");
        await flushFailures();

        const failResult = counters.toResult({
            success: false,
            mode: "initialization",
            syncRunId,
            errors: [errorMessage, ...errors],
            durationMs: Date.now() - startTime,
            lagSeconds: undefined,
        });
        await persistRun(runRepository, failResult, startedAt);
        return failResult;
    }
}
