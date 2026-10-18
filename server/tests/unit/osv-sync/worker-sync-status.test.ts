/**
 * Worker Sync Status Tests
 *
 * Verifies that the OSV sync worker correctly sets and clears the
 * syncStatus field in osv_sync_state during initialization and
 * incremental sync operations — including failure paths.
 *
 * Also covers the two rules that keep a rebuild from being able to take the
 * mirror down: the scheduled path refuses to bootstrap at all, and a rebuild
 * only becomes live once it has been judged complete enough to publish.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOsvSyncWorker, type OsvSyncWorker } from "../../../src/osv-sync/worker.js";

vi.mock("../../../src/repositories/index.js", () => ({
    vulnerabilityMirrorRepository: {
        bulkUpsertFromSync: vi.fn().mockResolvedValue({ rows: [], inserted: 0, updated: 0, unchanged: 0 }),
        getVulnerabilityCountEstimate: vi.fn().mockResolvedValue(0),
    },
}));
// The two post-import passes read the app's own `db`; this file exercises the
// worker's lifecycle, not theirs (`scoped-bootstrap.test.ts` mocks them the
// same way), and a unit run has no database to reach.
vi.mock("../../../src/osv-sync/severity-fill.js", () => ({
    fillInheritedSeverity: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../../src/osv-sync/rescan.js", () => ({
    enqueueRescansAfterMirrorChange: vi.fn().mockResolvedValue(0),
}));
import type { SyncStateManager } from "../../../src/osv-sync/state.js";
import type { OsvDownloader } from "../../../src/osv-sync/downloader.js";
import type { ZipProcessor } from "../../../src/osv-sync/zip-processor.js";
import type { OsvAffectedPackageRepository } from "../../../src/osv-sync/affected-package-repository.js";
import type { OsvSyncFailureRepository } from "../../../src/osv-sync/failure-repository.js";
import type { OsvSyncRunRepository } from "../../../src/osv-sync/run-repository.js";
import type { OsvSyncConfig } from "../../../src/osv-sync/config.js";
import type { SyncStatus } from "../../../src/db/schema/osv-mirror.js";
import type { ModifiedEntry } from "../../../src/osv-sync/parser.js";
import type { DownloadResult } from "../../../src/osv-sync/downloader.js";

function createMockConfig(): OsvSyncConfig {
    return {
        databaseUrl: "postgres://test",
        osvAllZipUrl: "https://example.com/all.zip",
        osvModifiedCsvUrl: "https://example.com/modified_id.csv",
        osvStorageBaseUrl: "https://example.com",
        overlapWindowMinutes: 10,
        maxParallelDownloads: 4,
        batchSize: 100,
        bulkFallbackThreshold: 5000,
        lagWarningThresholdHours: 6,
        failureRetentionDays: 30,
        userAgent: "test/1.0",
        requestTimeoutMs: 5000,
        streamStallTimeoutMs: 5000,
        maxRetries: 1,
        retryBaseDelayMs: 100,
        bootstrapMaxFailedEntries: 10,
        bootstrapMaxFailedEntryRatio: 0.005,
        advisoryLockId: 99999,
        ecosystems: null,
    };
}

function createMockStateManager(overrides?: Partial<SyncStateManager>): SyncStateManager {
    let currentStatus: SyncStatus = "idle";

    return {
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue({
            id: 1,
            initialized: false,
            syncStatus: "idle",
            consecutiveFailures: 0,
            lastError: null,
            initCompletedAt: null,
            lastSuccessfulPollAt: null,
            lastModifiedSeen: null,
            lastModifiedApplied: null,
            lastFullRefreshAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        }),
        updateState: vi.fn().mockResolvedValue(undefined),
        markInitialized: vi.fn().mockResolvedValue(undefined),
        recordSuccessfulSync: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
        getLagSeconds: vi.fn().mockResolvedValue(0),
        setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
            currentStatus = status;
        }),
        getSyncStatus: vi.fn().mockImplementation(async () => currentStatus),
        tryAcquireAdvisoryLock: vi.fn().mockResolvedValue(true),
        releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    };
}

function createMockDownloader(): OsvDownloader {
    return {
        download: vi.fn().mockResolvedValue({ data: Buffer.from("") }),
        downloadMany: vi.fn().mockResolvedValue([]),
        streamLines: vi.fn().mockImplementation(() => linesOf("")),
        computeSha256: vi.fn().mockReturnValue(Buffer.alloc(32)),
    } as unknown as OsvDownloader;
}

async function* linesOf(csv: string): AsyncGenerator<string> {
    for (const line of csv.split("\n")) yield line;
}

/** Point the downloader's line stream at a modified_id.csv body. */
function serveCsv(downloader: OsvDownloader, csv: string): void {
    vi.mocked(downloader.streamLines).mockImplementation(() => linesOf(csv));
}

function createMockZipProcessor(): ZipProcessor {
    return {
        processZip: vi.fn().mockResolvedValue({
            processedCount: 1_000,
            errorCount: 0,
            maxModifiedTimestamp: new Date("2024-01-01"),
            errors: [],
        }),
    } as unknown as ZipProcessor;
}

function createMockAffectedPkgRepo(): OsvAffectedPackageRepository {
    return {
        truncate: vi.fn().mockResolvedValue(undefined),
        bulkInsert: vi.fn().mockResolvedValue(0),
        replaceForVulns: vi.fn().mockResolvedValue({ deleted: 0, inserted: 0 }),
        deleteByVulnIds: vi.fn().mockResolvedValue(0),
        getCount: vi.fn().mockResolvedValue(0),
        getCurrentGeneration: vi.fn().mockResolvedValue(1),
        promoteGeneration: vi.fn().mockResolvedValue({ deleted: 0 }),
        discardGeneration: vi.fn().mockResolvedValue(0),
    };
}

function createMockRunRepo(): OsvSyncRunRepository {
    return {
        insert: vi.fn().mockResolvedValue(undefined),
    };
}

function createMockFailureRepo(): OsvSyncFailureRepository {
    return {
        bulkInsert: vi.fn().mockResolvedValue(0),
        deleteOlderThan: vi.fn().mockResolvedValue(0),
    } as unknown as OsvSyncFailureRepository;
}

describe("Worker sync status lifecycle", () => {
    let config: OsvSyncConfig;
    let stateManager: SyncStateManager;
    let downloader: OsvDownloader;
    let zipProcessor: ZipProcessor;
    let affectedPkgRepo: OsvAffectedPackageRepository;
    let failureRepo: OsvSyncFailureRepository;
    let runRepo: OsvSyncRunRepository;
    let worker: OsvSyncWorker;

    beforeEach(() => {
        config = createMockConfig();
        stateManager = createMockStateManager();
        downloader = createMockDownloader();
        zipProcessor = createMockZipProcessor();
        affectedPkgRepo = createMockAffectedPkgRepo();
        failureRepo = createMockFailureRepo();
        runRepo = createMockRunRepo();
    });

    function buildWorker(overrides?: { stateManager?: SyncStateManager }) {
        const sm = overrides?.stateManager ?? stateManager;
        worker = createOsvSyncWorker(config, sm, downloader, zipProcessor, affectedPkgRepo, failureRepo, runRepo);
        return worker;
    }

    describe("initialization (full refresh)", () => {
        it("should set syncStatus to 'full_refresh' at start and clear to idle on success", async () => {
            const statusCalls: SyncStatus[] = [];
            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: false,
                    syncStatus: "idle",
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: null,
                    lastSuccessfulPollAt: null,
                    lastModifiedSeen: null,
                    lastModifiedApplied: null,
                    lastFullRefreshAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
                    statusCalls.push(status);
                }),
            });

            buildWorker({ stateManager: sm });
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(true);
            expect(result.mode).toBe("initialization");

            // Should have set full_refresh at start; markInitialized resets to idle internally
            expect(statusCalls[0]).toBe("full_refresh");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("full_refresh");
            expect(sm.markInitialized).toHaveBeenCalled();
        });

        it("should reset syncStatus to idle on initialization failure", async () => {
            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: false,
                    syncStatus: "idle",
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: null,
                    lastSuccessfulPollAt: null,
                    lastModifiedSeen: null,
                    lastModifiedApplied: null,
                    lastFullRefreshAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            });

            // Make zip processing throw
            vi.mocked(zipProcessor.processZip).mockRejectedValue(new Error("Network timeout"));

            buildWorker({ stateManager: sm });
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(false);
            expect(result.mode).toBe("initialization");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("full_refresh");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("idle");
            expect(sm.recordFailure).toHaveBeenCalledWith("Network timeout");
        });

        it("publishes the rebuilt generation only after the import succeeds", async () => {
            buildWorker();
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(true);
            // Built as generation 2 while 1 was being served, then swapped in.
            expect(affectedPkgRepo.promoteGeneration).toHaveBeenCalledWith(2);
            expect(stateManager.markInitialized).toHaveBeenCalled();
            // Nothing is ever truncated — that is what keeps matching up.
            expect(affectedPkgRepo.truncate).not.toHaveBeenCalled();
        });

        it("discards the half-built generation and keeps the live one when the import throws", async () => {
            vi.mocked(zipProcessor.processZip).mockRejectedValue(new Error("OOM"));

            buildWorker();
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(false);
            expect(affectedPkgRepo.promoteGeneration).not.toHaveBeenCalled();
            expect(affectedPkgRepo.discardGeneration).toHaveBeenCalledWith(2);
            expect(stateManager.markInitialized).not.toHaveBeenCalled();
        });

        it("refuses to publish a rebuild that lost too much of the corpus", async () => {
            // 500 of 1000 entries failed: past both the absolute and the ratio bound.
            vi.mocked(zipProcessor.processZip).mockResolvedValue({
                processedCount: 500,
                errorCount: 500,
                maxModifiedTimestamp: new Date("2024-01-01"),
                errors: [],
            });

            buildWorker();
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(false);
            expect(result.errors.join(" ")).toMatch(/failed on 500 of 1000/);
            expect(affectedPkgRepo.promoteGeneration).not.toHaveBeenCalled();
            expect(stateManager.markInitialized).not.toHaveBeenCalled();
            expect(affectedPkgRepo.discardGeneration).toHaveBeenCalledWith(2);
        });

        it("publishes a rebuild whose failures are a rounding error", async () => {
            // 5 failures in a million: over neither bound.
            vi.mocked(zipProcessor.processZip).mockResolvedValue({
                processedCount: 999_995,
                errorCount: 5,
                maxModifiedTimestamp: new Date("2024-01-01"),
                errors: [],
            });

            buildWorker();
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(true);
            expect(affectedPkgRepo.promoteGeneration).toHaveBeenCalledWith(2);
        });

        it("refuses to publish a rebuild that produced no watermark", async () => {
            vi.mocked(zipProcessor.processZip).mockResolvedValue({
                processedCount: 1_000,
                errorCount: 0,
                maxModifiedTimestamp: null,
                errors: [],
            });

            buildWorker();
            const result = await worker.forceFullRefresh();

            expect(result.success).toBe(false);
            expect(result.errors.join(" ")).toMatch(/watermark/);
            expect(stateManager.markInitialized).not.toHaveBeenCalled();
        });
    });

    describe("scheduled runs never bootstrap", () => {
        it("fails loudly instead of starting a full rebuild when the mirror is uninitialized", async () => {
            buildWorker();
            const result = await worker.runCycle();

            expect(result.success).toBe(false);
            expect(result.errors[0]).toMatch(/not initialized/);
            expect(result.errors[0]).toMatch(/--full-refresh/);
            expect(zipProcessor.processZip).not.toHaveBeenCalled();
            expect(stateManager.setSyncStatus).not.toHaveBeenCalledWith("full_refresh");
        });
    });

    describe("bootstrapIfNeeded", () => {
        function stateRow(initialized: boolean) {
            return {
                id: 1,
                initialized,
                syncStatus: "idle" as SyncStatus,
                consecutiveFailures: 0,
                lastError: null,
                initCompletedAt: null,
                lastSuccessfulPollAt: null,
                lastModifiedSeen: null,
                lastModifiedApplied: null,
                lastFullRefreshAt: null,
                affectedPkgGeneration: 1,
                ecosystems: null,
                bootstrapProgress: null,
                createdAt: new Date(),
                updatedAt: new Date(),
            };
        }

        /** The default mock state, with `initialized` forced to a given value. */
        function stateWithInitialized(initialized: boolean): SyncStateManager {
            return createMockStateManager({
                getState: vi.fn().mockResolvedValue(stateRow(initialized)),
            });
        }

        it("rebuilds when the mirror has never completed a generation", async () => {
            const sm = stateWithInitialized(false);
            buildWorker({ stateManager: sm });

            const result = await worker.bootstrapIfNeeded();

            expect(result.success).toBe(true);
            expect(result.noop).toBeFalsy();
            expect(result.mode).toBe("initialization");
            expect(zipProcessor.processZip).toHaveBeenCalled();
            expect(sm.markInitialized).toHaveBeenCalled();
        });

        // The outcome on every run but the first. This fires twice a day
        // forever, so it must cost nothing and must not look like an event.
        it("does nothing and reports noop when a generation already exists", async () => {
            const sm = stateWithInitialized(true);
            buildWorker({ stateManager: sm });

            const result = await worker.bootstrapIfNeeded();

            expect(result.success).toBe(true);
            expect(result.noop).toBe(true);
            expect(result.errors).toEqual([]);
            expect(zipProcessor.processZip).not.toHaveBeenCalled();
            expect(sm.setSyncStatus).not.toHaveBeenCalledWith("full_refresh");
        });

        // No lock round-trip on the common path.
        it("does not take the advisory lock when there is nothing to do", async () => {
            const sm = stateWithInitialized(true);
            buildWorker({ stateManager: sm });

            await worker.bootstrapIfNeeded();

            expect(sm.tryAcquireAdvisoryLock).not.toHaveBeenCalled();
        });

        // A manual --full-refresh finishing between the pre-check and the lock
        // must not turn into a second multi-hour rebuild on top of it.
        it("re-checks under the lock and bails if the mirror was initialized in the gap", async () => {
            const sm = stateWithInitialized(false);
            vi.mocked(sm.getState)
                .mockResolvedValueOnce(stateRow(false)) // pre-check: empty
                .mockResolvedValueOnce(stateRow(true)); // under the lock: filled in the gap

            buildWorker({ stateManager: sm });
            const result = await worker.bootstrapIfNeeded();

            expect(sm.tryAcquireAdvisoryLock).toHaveBeenCalled();
            expect(result.noop).toBe(true);
            expect(zipProcessor.processZip).not.toHaveBeenCalled();
        });

        // Contention is benign: exit 0 so the Job's backoffLimit is not spent
        // and no alert fires.
        it("skips rather than fails when another instance holds the lock", async () => {
            const sm = stateWithInitialized(false);
            vi.mocked(sm.tryAcquireAdvisoryLock).mockResolvedValue(false);
            buildWorker({ stateManager: sm });

            const result = await worker.bootstrapIfNeeded();

            expect(result.skipped).toBe(true);
            expect(result.noop).toBeFalsy();
            expect(zipProcessor.processZip).not.toHaveBeenCalled();
        });
    });

    describe("one run per process at a time", () => {
        /**
         * The monolith's regression: the hourly incremental tick fired inside
         * the start-up bootstrap, believed it held the lock, "recovered" the
         * bootstrap's status to idle and released the lock under it.
         */
        it("skips an incremental run that fires while a bootstrap is in progress, and keeps the lock", async () => {
            let status: SyncStatus = "idle";
            const sm = createMockStateManager({
                getState: vi.fn().mockImplementation(async () => ({
                    id: 1,
                    initialized: false,
                    syncStatus: status,
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: null,
                    lastSuccessfulPollAt: null,
                    lastModifiedSeen: null,
                    lastModifiedApplied: null,
                    lastFullRefreshAt: null,
                    affectedPkgGeneration: 1,
                    ecosystems: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })),
                setSyncStatus: vi.fn().mockImplementation(async (next: SyncStatus) => {
                    status = next;
                }),
            });
            let finishImport!: () => void;
            vi.mocked(zipProcessor.processZip).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishImport = () =>
                            resolve({
                                processedCount: 1_000,
                                errorCount: 0,
                                maxModifiedTimestamp: new Date("2024-01-01"),
                                errors: [],
                            });
                    }),
            );
            buildWorker({ stateManager: sm });

            const bootstrap = worker.bootstrapIfNeeded();
            await vi.waitFor(() => expect(status).toBe("full_refresh"));

            // The hourly tick, and the scheduler's release after it.
            const tick = await worker.runCycle();
            await worker.shutdown();

            expect(tick.skipped).toBe(true);
            expect(tick.errors[0]).toMatch(/already running in this process/);
            expect(status).toBe("full_refresh");
            expect(sm.setSyncStatus).not.toHaveBeenCalledWith("idle");
            expect(sm.releaseAdvisoryLock).not.toHaveBeenCalled();
            expect(sm.tryAcquireAdvisoryLock).toHaveBeenCalledTimes(1);

            finishImport();
            const result = await bootstrap;
            expect(result.success).toBe(true);
            expect(sm.markInitialized).toHaveBeenCalledTimes(1);

            // Once the run is over, the release goes through.
            await worker.shutdown();
            expect(sm.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
        });

        it("skips a second bootstrap requested while the first is still running", async () => {
            let finishImport!: () => void;
            vi.mocked(zipProcessor.processZip).mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishImport = () =>
                            resolve({
                                processedCount: 1_000,
                                errorCount: 0,
                                maxModifiedTimestamp: new Date("2024-01-01"),
                                errors: [],
                            });
                    }),
            );
            buildWorker();

            const first = worker.forceFullRefresh();
            await vi.waitFor(() => expect(zipProcessor.processZip).toHaveBeenCalledTimes(1));
            const second = await worker.bootstrapIfNeeded();

            expect(second.skipped).toBe(true);
            expect(zipProcessor.processZip).toHaveBeenCalledTimes(1);

            finishImport();
            expect((await first).success).toBe(true);
        });
    });

    describe("incremental sync", () => {
        function makeInitializedStateManager(overrides?: Partial<SyncStateManager>) {
            return createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "idle",
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: new Date("2024-01-15T12:00:00Z"),
                    lastModifiedApplied: new Date("2024-01-15T12:00:00Z"),
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                ...overrides,
            });
        }

        it("should set syncStatus to 'incremental' at start and clear to idle on success (empty CSV)", async () => {
            const sm = makeInitializedStateManager();

            // Return an empty CSV
            serveCsv(downloader, "");

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.mode).toBe("incremental");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("incremental");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("idle");
        });

        /**
         * Both kinds of trouble write a row to `osv_sync_failures`, and for a
         * long time both also incremented `parseFailures` — so a mirror that
         * had ingested every advisory reported tens of thousands of failures
         * and the metric stopped meaning anything. The two counters have to
         * move independently.
         */
        describe("failure accounting", () => {
            const MODIFIED = new Date("2024-02-01T00:00:00Z");

            /** Serve one candidate whose downloaded body is `body`. */
            function serveOneRecord(body: unknown) {
                serveCsv(downloader, ["modified,path", `${MODIFIED.toISOString()},npm/CVE-2024-9999`].join("\n"));
                vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                    const results = new Map<ModifiedEntry, DownloadResult | Error>();
                    for (const entry of items as ModifiedEntry[]) {
                        results.set(entry, {
                            data: Buffer.from(JSON.stringify(body)),
                            etag: undefined,
                            lastModified: undefined,
                            contentLength: undefined,
                        });
                    }
                    return results;
                });
            }

            const recordedTypes = () =>
                vi
                    .mocked(failureRepo.bulkInsert)
                    .mock.calls.flatMap(([rows]) => rows as Array<{ errorType: string }>)
                    .map((row) => row.errorType);

            it("counts a schema deviation as a warning, not a parse failure", async () => {
                // Ingestible, but the reference has no `url` — the exact shape
                // openSUSE publishes, and 7,809 records' worth of the noise.
                serveOneRecord({
                    id: "CVE-2024-9999",
                    modified: MODIFIED.toISOString(),
                    references: [{ type: "ADVISORY" }],
                    affected: [{ package: { name: "lodash", ecosystem: "npm" } }],
                });

                buildWorker({ stateManager: makeInitializedStateManager() });
                const result = await worker.runCycle();

                expect(result.success).toBe(true);
                expect(result.schemaValidationWarnings).toBe(1);
                expect(result.parseFailures).toBe(0);
                expect(recordedTypes()).toEqual(["validation_warning"]);
            });

            it("counts an unparseable record as a parse failure", async () => {
                // No `modified`, so parseOsvJson throws before validation.
                serveOneRecord({ id: "CVE-2024-9999", references: [] });

                buildWorker({ stateManager: makeInitializedStateManager() });
                const result = await worker.runCycle();

                expect(result.parseFailures).toBe(1);
                expect(result.schemaValidationWarnings).toBe(0);
                expect(recordedTypes()).toEqual(["parse_error"]);
            });

            it("counts a failed download as a parse failure", async () => {
                serveCsv(downloader, ["modified,path", `${MODIFIED.toISOString()},npm/CVE-2024-9999`].join("\n"));
                vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                    const results = new Map<ModifiedEntry, DownloadResult | Error>();
                    for (const entry of items as ModifiedEntry[]) {
                        results.set(entry, new Error("connection reset"));
                    }
                    return results;
                });

                buildWorker({ stateManager: makeInitializedStateManager() });
                const result = await worker.runCycle();

                expect(result.parseFailures).toBe(1);
                expect(result.schemaValidationWarnings).toBe(0);
                expect(recordedTypes()).toEqual(["download_error"]);
            });
        });

        it("should set syncStatus to 'incremental' and clear to idle with candidates", async () => {
            const statusCalls: SyncStatus[] = [];
            const sm = makeInitializedStateManager({
                setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
                    statusCalls.push(status);
                }),
            });

            // CSV with one entry that's newer than our watermark
            serveCsv(downloader, "2024-01-16T00:00:00Z,npm/CVE-2024-1234\n");

            // downloadMany returns an empty map (no candidates to download)
            vi.mocked(downloader.downloadMany).mockResolvedValue(new Map());

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.mode).toBe("incremental");
            expect(statusCalls).toContain("incremental");
            expect(statusCalls[statusCalls.length - 1]).toBe("idle");
        });

        it("should reset syncStatus to idle on incremental failure", async () => {
            const sm = makeInitializedStateManager();

            // Make the CSV stream throw
            vi.mocked(downloader.streamLines).mockImplementation(() => {
                throw new Error("DNS resolution failed");
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(false);
            expect(result.mode).toBe("incremental");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("incremental");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("idle");
            expect(sm.recordFailure).toHaveBeenCalledWith("DNS resolution failed");
        });
    });

    describe("forceFullRefresh", () => {
        it("should set syncStatus to 'full_refresh' during forced refresh", async () => {
            const sm = createMockStateManager({
                getState: vi
                    .fn()
                    .mockResolvedValueOnce({
                        id: 1,
                        initialized: true,
                        syncStatus: "idle",
                        consecutiveFailures: 0,
                        lastError: null,
                        initCompletedAt: new Date(),
                        lastSuccessfulPollAt: new Date(),
                        lastModifiedSeen: new Date(),
                        lastModifiedApplied: new Date(),
                        lastFullRefreshAt: new Date(),
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    })
                    .mockResolvedValue({
                        id: 1,
                        initialized: false,
                        syncStatus: "idle",
                        consecutiveFailures: 0,
                        lastError: null,
                        initCompletedAt: null,
                        lastSuccessfulPollAt: null,
                        lastModifiedSeen: null,
                        lastModifiedApplied: null,
                        lastFullRefreshAt: null,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    }),
            });

            buildWorker({ stateManager: sm });
            const result = await worker.forceFullRefresh();

            expect(result.mode).toBe("initialization");
            expect(sm.setSyncStatus).toHaveBeenCalledWith("full_refresh");
            expect(sm.markInitialized).toHaveBeenCalled();
        });
    });

    describe("advisory lock not acquired", () => {
        it("should NOT set syncStatus when advisory lock is not acquired", async () => {
            const sm = createMockStateManager({
                tryAcquireAdvisoryLock: vi.fn().mockResolvedValue(false),
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(false);
            expect(sm.setSyncStatus).not.toHaveBeenCalled();
        });
    });

    describe("stale syncStatus recovery", () => {
        it("resets non-idle syncStatus to idle before running when we hold the lock", async () => {
            const statusCalls: SyncStatus[] = [];
            const sm = createMockStateManager({
                // State left behind by a crashed initialization run
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: false,
                    syncStatus: "full_refresh", // stale from previous crash
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: null,
                    lastSuccessfulPollAt: null,
                    lastModifiedSeen: null,
                    lastModifiedApplied: null,
                    lastFullRefreshAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
                    statusCalls.push(status);
                }),
            });

            buildWorker({ stateManager: sm });
            await worker.forceFullRefresh();

            // First call must reset the stale status to idle
            expect(statusCalls[0]).toBe("idle");
            // Then initialization sets it to full_refresh
            expect(statusCalls[1]).toBe("full_refresh");
        });

        it("still clears a stale status on the scheduled path that refuses to bootstrap", async () => {
            const statusCalls: SyncStatus[] = [];
            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: false,
                    syncStatus: "full_refresh", // stale from a crashed bootstrap
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: null,
                    lastSuccessfulPollAt: null,
                    lastModifiedSeen: null,
                    lastModifiedApplied: null,
                    lastFullRefreshAt: null,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
                    statusCalls.push(status);
                }),
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            // The stale flag is cleared — leaving it set would be its own problem —
            // but the rebuild itself is still refused.
            expect(statusCalls).toEqual(["idle"]);
            expect(result.success).toBe(false);
        });

        it("resets stale 'incremental' status before running", async () => {
            const statusCalls: SyncStatus[] = [];
            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "incremental", // stale
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: new Date("2024-01-15T12:00:00Z"),
                    lastModifiedApplied: new Date("2024-01-15T12:00:00Z"),
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
                setSyncStatus: vi.fn().mockImplementation(async (status: SyncStatus) => {
                    statusCalls.push(status);
                }),
            });

            // Return empty CSV so incremental exits immediately
            serveCsv(downloader, "");

            buildWorker({ stateManager: sm });
            await worker.runCycle();

            expect(statusCalls[0]).toBe("idle"); // recovery
            expect(statusCalls[1]).toBe("incremental"); // normal incremental start
        });

        it("does NOT call setSyncStatus('idle') when status is already idle", async () => {
            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "idle",
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: new Date("2024-01-15T12:00:00Z"),
                    lastModifiedApplied: new Date("2024-01-15T12:00:00Z"),
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            });

            serveCsv(downloader, "");

            buildWorker({ stateManager: sm });
            await worker.runCycle();

            // No recovery reset — first setSyncStatus call must be the sync mode itself
            const calls = vi.mocked(sm.setSyncStatus).mock.calls.map(([s]) => s);
            expect(calls[0]).toBe("incremental");
        });
    });

    describe("changed-only affected-package rebuilds", () => {
        // The upsert is filtered on raw_hash, so it can now say which advisories
        // actually moved. Every overlap window re-downloads records the mirror
        // already has; rewriting their affected-package rows was churn and
        // table bloat that bought nothing.
        it("replaces rows for changed advisories and leaves unchanged ones alone", async () => {
            const T0 = new Date("2024-01-15T00:00:00Z");
            const T1 = new Date("2024-01-16T01:00:00Z");

            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "idle" as SyncStatus,
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: T0,
                    lastModifiedApplied: T0,
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            });

            serveCsv(
                downloader,
                [
                    "modified,path",
                    `${T1.toISOString()},npm/CVE-2024-0001`,
                    `${T1.toISOString()},npm/CVE-2024-0002`,
                ].join("\n"),
            );

            vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                const results = new Map<ModifiedEntry, DownloadResult | Error>();
                for (const entry of items as ModifiedEntry[]) {
                    results.set(entry, {
                        data: Buffer.from(
                            JSON.stringify({
                                id: entry.vulnId,
                                modified: entry.modifiedTimestamp.toISOString(),
                                affected: [{ package: { name: "lodash", ecosystem: "npm" } }],
                            }),
                        ),
                        etag: undefined,
                        lastModified: undefined,
                        contentLength: undefined,
                    });
                }
                return results;
            });

            // Only the first advisory came back from the upsert — the second one
            // hashed identically to what is already stored.
            const repos = await import("../../../src/repositories/index.js");
            vi.mocked(repos.vulnerabilityMirrorRepository.bulkUpsertFromSync).mockResolvedValue({
                rows: [
                    {
                        id: "11111111-1111-1111-1111-111111111111",
                        vulnId: "CVE-2024-0001",
                        changed: true,
                        inserted: false,
                    },
                ],
                inserted: 0,
                updated: 1,
                unchanged: 1,
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.updated).toBe(1);
            expect(result.unchanged).toBe(1);
            expect(affectedPkgRepo.replaceForVulns).toHaveBeenCalledTimes(1);
            expect(affectedPkgRepo.replaceForVulns).toHaveBeenCalledWith(
                ["11111111-1111-1111-1111-111111111111"],
                expect.arrayContaining([expect.objectContaining({ packageName: "lodash" })]),
                1,
            );
        });

        it("does not touch affected packages at all when nothing changed", async () => {
            const T0 = new Date("2024-01-15T00:00:00Z");
            const T1 = new Date("2024-01-16T01:00:00Z");

            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "idle" as SyncStatus,
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: T0,
                    lastModifiedApplied: T0,
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            });

            serveCsv(downloader, ["modified,path", `${T1.toISOString()},npm/CVE-2024-0001`].join("\n"));

            vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                const results = new Map<ModifiedEntry, DownloadResult | Error>();
                for (const entry of items as ModifiedEntry[]) {
                    results.set(entry, {
                        data: Buffer.from(
                            JSON.stringify({ id: entry.vulnId, modified: entry.modifiedTimestamp.toISOString() }),
                        ),
                        etag: undefined,
                        lastModified: undefined,
                        contentLength: undefined,
                    });
                }
                return results;
            });

            const repos = await import("../../../src/repositories/index.js");
            vi.mocked(repos.vulnerabilityMirrorRepository.bulkUpsertFromSync).mockResolvedValue({
                rows: [],
                inserted: 0,
                updated: 0,
                unchanged: 1,
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.unchanged).toBe(1);
            expect(affectedPkgRepo.replaceForVulns).not.toHaveBeenCalled();
            // The watermark still moves: the record was applied, it just did not differ.
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(expect.objectContaining({ maxModifiedApplied: T1 }));
        });
    });

    describe("burst-day archive fallback", () => {
        const T0 = new Date("2024-01-15T00:00:00Z");
        const T1 = new Date("2024-01-16T01:00:00Z");

        function burstStateManager() {
            return createMockStateManager({
                getState: vi.fn().mockResolvedValue({
                    id: 1,
                    initialized: true,
                    syncStatus: "idle" as SyncStatus,
                    consecutiveFailures: 0,
                    lastError: null,
                    initCompletedAt: new Date(),
                    lastSuccessfulPollAt: new Date(),
                    lastModifiedSeen: T0,
                    lastModifiedApplied: T0,
                    lastFullRefreshAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                }),
            });
        }

        /** Serve per-ecosystem archives holding the given records. */
        function serveArchives(archives: Record<string, { vulnId: string; modified: Date }[]>) {
            vi.mocked(zipProcessor.processZip).mockImplementation(async (url: string, onRecord, options) => {
                const dir = url.split("/").slice(-2, -1)[0]!;
                let processedCount = 0;

                for (const record of archives[dir] ?? []) {
                    const entry = {
                        path: `${dir}/${record.vulnId}.json`,
                        ecosystemDir: dir,
                        vulnId: record.vulnId,
                    };
                    if (options?.filter && !options.filter(entry)) continue;

                    const raw = {
                        id: record.vulnId,
                        modified: record.modified.toISOString(),
                        affected: [{ package: { name: "lodash", ecosystem: "npm" } }],
                    };
                    await onRecord(
                        {
                            id: record.vulnId,
                            modified: record.modified,
                            published: undefined,
                            withdrawn: undefined,
                            raw,
                            rawSha256: Buffer.alloc(32),
                            validationErrors: [],
                            severity: null,
                        },
                        entry,
                    );
                    processedCount++;
                }

                return { processedCount, errorCount: 0, maxModifiedTimestamp: null, errors: [] };
            });
        }

        it("pulls one archive per ecosystem instead of thousands of GETs", async () => {
            config.bulkFallbackThreshold = 3;
            const sm = burstStateManager();

            serveCsv(
                downloader,
                [
                    "modified,path",
                    `${T1.toISOString()},npm/CVE-2024-0001`,
                    `${T1.toISOString()},npm/CVE-2024-0002`,
                    `${T1.toISOString()},PyPI/CVE-2024-0003`,
                ].join("\n"),
            );
            serveArchives({
                npm: [
                    { vulnId: "CVE-2024-0001", modified: T1 },
                    { vulnId: "CVE-2024-0002", modified: T1 },
                    { vulnId: "CVE-2024-9999", modified: T1 }, // not a candidate
                ],
                PyPI: [{ vulnId: "CVE-2024-0003", modified: T1 }],
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(downloader.downloadMany).not.toHaveBeenCalled();
            expect(zipProcessor.processZip).toHaveBeenCalledTimes(2);
            expect(vi.mocked(zipProcessor.processZip).mock.calls.map(([url]) => url)).toEqual([
                "https://example.com/npm/all.zip",
                "https://example.com/PyPI/all.zip",
            ]);
            // Three candidates applied; the fourth record in the npm archive was
            // filtered out before it was ever decompressed.
            expect(result.recordsProcessed).toBe(3);
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(expect.objectContaining({ maxModifiedApplied: T1 }));
        });

        it("stays on per-record downloads below the threshold", async () => {
            config.bulkFallbackThreshold = 5000;
            const sm = burstStateManager();

            serveCsv(downloader, ["modified,path", `${T1.toISOString()},npm/CVE-2024-0001`].join("\n"));
            vi.mocked(downloader.downloadMany).mockResolvedValue(new Map());

            buildWorker({ stateManager: sm });
            await worker.runCycle();

            expect(downloader.downloadMany).toHaveBeenCalled();
            expect(zipProcessor.processZip).not.toHaveBeenCalled();
        });

        it("caps the watermark for a candidate the archive does not carry", async () => {
            config.bulkFallbackThreshold = 2;
            const sm = burstStateManager();

            const T2 = new Date("2024-01-16T02:00:00Z");
            serveCsv(
                downloader,
                [
                    "modified,path",
                    `${T1.toISOString()},npm/CVE-2024-0001`,
                    `${T2.toISOString()},npm/CVE-2024-0002`,
                ].join("\n"),
            );
            // The archive is a snapshot and does not carry the older advisory —
            // which is the awkward case, because the newer one *was* applied and
            // would otherwise drag the watermark past the gap.
            serveArchives({ npm: [{ vulnId: "CVE-2024-0002", modified: T2 }] });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.parseFailures).toBe(1);
            // Capped to just before the missing record, so the next run retries it.
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(
                expect.objectContaining({ maxModifiedApplied: new Date(T1.getTime() - 1) }),
            );
        });

        it("treats a stale archive copy as a failure rather than applying it", async () => {
            config.bulkFallbackThreshold = 2;
            const sm = burstStateManager();

            const T2 = new Date("2024-01-16T02:00:00Z");
            serveCsv(
                downloader,
                [
                    "modified,path",
                    `${T1.toISOString()},npm/CVE-2024-0001`,
                    `${T2.toISOString()},npm/CVE-2024-0002`,
                ].join("\n"),
            );
            // The archive still holds yesterday's copy of the *older* advisory,
            // so the newer one is applied and must not carry the watermark past it.
            serveArchives({
                npm: [
                    { vulnId: "CVE-2024-0001", modified: T0 },
                    { vulnId: "CVE-2024-0002", modified: T2 },
                ],
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.parseFailures).toBe(1);
            expect(result.recordsProcessed).toBe(1);
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(
                expect.objectContaining({ maxModifiedApplied: new Date(T1.getTime() - 1) }),
            );
        });

        it("keeps going when one ecosystem's archive fails", async () => {
            config.bulkFallbackThreshold = 2;
            const sm = burstStateManager();

            serveCsv(
                downloader,
                [
                    "modified,path",
                    `${T1.toISOString()},npm/CVE-2024-0001`,
                    `${T1.toISOString()},PyPI/CVE-2024-0002`,
                ].join("\n"),
            );
            serveArchives({ PyPI: [{ vulnId: "CVE-2024-0002", modified: T1 }] });
            const working = vi.mocked(zipProcessor.processZip).getMockImplementation()!;
            vi.mocked(zipProcessor.processZip).mockImplementation(async (url, onRecord, options) => {
                if (url.includes("/npm/")) throw new Error("HTTP 500");
                return working(url, onRecord, options);
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            // The PyPI record was applied; the npm one is a failure to retry.
            expect(result.recordsProcessed).toBe(1);
            expect(result.parseFailures).toBe(1);
        });
    });

    describe("lock contention is a skip, not a failure", () => {
        it("marks the result skipped so the CLI can exit 0", async () => {
            const sm = createMockStateManager({
                tryAcquireAdvisoryLock: vi.fn().mockResolvedValue(false),
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            // A manual run overlapping the CronJob is benign; reporting it as a
            // failure burns the Job's backoffLimit and alerts on nothing.
            expect(result.skipped).toBe(true);
            expect(result.success).toBe(false);
        });
    });

    describe("watermark capping on download failures", () => {
        function makeInitializedState(lastModifiedApplied: Date) {
            return {
                id: 1,
                initialized: true,
                syncStatus: "idle" as SyncStatus,
                consecutiveFailures: 0,
                lastError: null,
                initCompletedAt: new Date(),
                lastSuccessfulPollAt: new Date(),
                lastModifiedSeen: lastModifiedApplied,
                lastModifiedApplied,
                lastFullRefreshAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
            };
        }

        function makeOsvJsonBuffer(id: string, modified: string): Buffer {
            return Buffer.from(JSON.stringify({ id, modified }));
        }

        it("caps watermark to just before earliest failure timestamp", async () => {
            const T0 = new Date("2024-01-15T00:00:00Z"); // previous watermark
            const T1 = new Date("2024-01-16T01:00:00Z"); // success
            const T2 = new Date("2024-01-16T02:00:00Z"); // FAILS
            const T3 = new Date("2024-01-16T03:00:00Z"); // success

            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue(makeInitializedState(T0)),
            });

            // CSV with three candidates, all newer than T0
            const csv = [
                "modified,path",
                `${T1.toISOString()},npm/CVE-2024-0001`,
                `${T2.toISOString()},npm/CVE-2024-0002`,
                `${T3.toISOString()},npm/CVE-2024-0003`,
            ].join("\n");
            serveCsv(downloader, csv);

            // downloadMany: T1 and T3 succeed, T2 returns an Error
            vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                const chunk = items as ModifiedEntry[];
                const results = new Map<ModifiedEntry, DownloadResult | Error>();
                for (const entry of chunk) {
                    if (entry.vulnId === "CVE-2024-0002") {
                        results.set(entry, new Error("HTTP 503"));
                    } else {
                        results.set(entry, {
                            data: makeOsvJsonBuffer(entry.vulnId, entry.modifiedTimestamp.toISOString()),
                            etag: undefined,
                            lastModified: undefined,
                            contentLength: undefined,
                        });
                    }
                }
                return results;
            });

            buildWorker({ stateManager: sm });
            const result = await worker.runCycle();

            expect(result.success).toBe(true);
            expect(result.parseFailures).toBe(1); // CVE-2024-0002 download failed

            // Watermark must be capped to T2 - 1ms, not T3
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(
                expect.objectContaining({
                    maxModifiedApplied: new Date(T2.getTime() - 1),
                }),
            );
        });

        it("caps to previous watermark when all candidates fail", async () => {
            const T0 = new Date("2024-01-15T00:00:00Z");
            const T1 = new Date("2024-01-16T01:00:00Z");

            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue(makeInitializedState(T0)),
            });

            const csv = ["modified,path", `${T1.toISOString()},npm/CVE-2024-0001`].join("\n");
            serveCsv(downloader, csv);

            vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                const chunk = items as ModifiedEntry[];
                const results = new Map<ModifiedEntry, DownloadResult | Error>();
                for (const entry of chunk) {
                    results.set(entry, new Error("Network error"));
                }
                return results;
            });

            buildWorker({ stateManager: sm });
            await worker.runCycle();

            // Cap = T1 - 1ms, which is less than T0 (previous watermark) — so clamp to T0
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(
                expect.objectContaining({
                    maxModifiedApplied: T0,
                }),
            );
        });

        it("does NOT cap watermark when all downloads succeed", async () => {
            const T0 = new Date("2024-01-15T00:00:00Z");
            const T1 = new Date("2024-01-16T01:00:00Z");

            const sm = createMockStateManager({
                getState: vi.fn().mockResolvedValue(makeInitializedState(T0)),
            });

            const csv = ["modified,path", `${T1.toISOString()},npm/CVE-2024-0001`].join("\n");
            serveCsv(downloader, csv);

            vi.mocked(downloader.downloadMany).mockImplementation(async (items: unknown[]) => {
                const chunk = items as ModifiedEntry[];
                const results = new Map<ModifiedEntry, DownloadResult | Error>();
                for (const entry of chunk) {
                    results.set(entry, {
                        data: Buffer.from(
                            JSON.stringify({ id: entry.vulnId, modified: entry.modifiedTimestamp.toISOString() }),
                        ),
                        etag: undefined,
                        lastModified: undefined,
                        contentLength: undefined,
                    });
                }
                return results;
            });

            buildWorker({ stateManager: sm });
            await worker.runCycle();

            // Watermark should be T1 (from the successfully processed record)
            expect(sm.recordSuccessfulSync).toHaveBeenCalledWith(
                expect.objectContaining({
                    maxModifiedApplied: T1,
                }),
            );
        });
    });
});
