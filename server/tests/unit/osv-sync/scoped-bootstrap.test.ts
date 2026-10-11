/**
 * The scoped mirror (`OSV_ECOSYSTEMS`), at the
 * worker boundary with every I/O mocked: which archives a bootstrap pulls,
 * what it refuses, how cross-listed records are taken once, what the
 * incremental sync ignores, and when `--bootstrap-if-needed` rebuilds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOsvSyncWorker, type OsvSyncWorker } from "../../../src/osv-sync/worker.js";

vi.mock("../../../src/repositories/index.js", () => ({
    vulnerabilityMirrorRepository: {
        bulkUpsertFromSync: vi.fn().mockResolvedValue({ rows: [], inserted: 0, updated: 0, unchanged: 0 }),
        getVulnerabilityCountEstimate: vi.fn().mockResolvedValue(0),
    },
}));
vi.mock("../../../src/osv-sync/severity-fill.js", () => ({
    fillInheritedSeverity: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../../src/osv-sync/rescan.js", () => ({
    enqueueRescansAfterMirrorChange: vi.fn().mockResolvedValue(0),
}));

import type { SyncStateManager } from "../../../src/osv-sync/state.js";
import type { OsvDownloader } from "../../../src/osv-sync/downloader.js";
import type { ZipProcessor, ZipEntryInfo, ZipProcessOptions } from "../../../src/osv-sync/zip-processor.js";
import type { ParsedOsvRecord } from "../../../src/osv-sync/parser.js";
import type { OsvAffectedPackageRepository } from "../../../src/osv-sync/affected-package-repository.js";
import type { OsvSyncFailureRepository } from "../../../src/osv-sync/failure-repository.js";
import type { OsvSyncRunRepository } from "../../../src/osv-sync/run-repository.js";
import type { OsvSyncConfig } from "../../../src/osv-sync/config.js";
import type { OsvSyncState } from "../../../src/db/schema/osv-mirror.js";

function config(ecosystems: string[] | null): OsvSyncConfig {
    return {
        databaseUrl: "postgres://test",
        osvAllZipUrl: "https://osv.example/all.zip",
        osvModifiedCsvUrl: "https://osv.example/modified_id.csv",
        osvStorageBaseUrl: "https://osv.example",
        overlapWindowMinutes: 10,
        maxParallelDownloads: 4,
        batchSize: 100,
        bulkFallbackThreshold: 5000,
        lagWarningThresholdHours: 6,
        failureRetentionDays: 0,
        userAgent: "test/1.0",
        requestTimeoutMs: 5000,
        streamStallTimeoutMs: 5000,
        maxRetries: 1,
        retryBaseDelayMs: 1,
        bootstrapMaxFailedEntries: 10,
        bootstrapMaxFailedEntryRatio: 0.005,
        advisoryLockId: 99999,
        ecosystems,
    };
}

function stateRow(overrides: Partial<OsvSyncState> = {}): OsvSyncState {
    return {
        id: 1,
        initialized: true,
        syncStatus: "idle",
        consecutiveFailures: 0,
        lastError: null,
        initCompletedAt: null,
        lastSuccessfulPollAt: null,
        lastModifiedSeen: null,
        lastModifiedApplied: new Date("2026-10-01T00:00:00Z"),
        lastFullRefreshAt: null,
        affectedPkgGeneration: 1,
        ecosystems: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

function stateManager(state: OsvSyncState): SyncStateManager {
    return {
        ensureInitialized: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue(state),
        updateState: vi.fn().mockResolvedValue(undefined),
        markInitialized: vi.fn().mockResolvedValue(undefined),
        recordSuccessfulSync: vi.fn().mockResolvedValue(undefined),
        recordFailure: vi.fn().mockResolvedValue(undefined),
        getLagSeconds: vi.fn().mockResolvedValue(0),
        setSyncStatus: vi.fn().mockResolvedValue(undefined),
        getSyncStatus: vi.fn().mockResolvedValue("idle"),
        tryAcquireAdvisoryLock: vi.fn().mockResolvedValue(true),
        releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
    };
}

async function* linesOf(csv: string): AsyncGenerator<string> {
    for (const line of csv.split("\n")) yield line;
}

const ECOSYSTEMS_TXT = "AlmaLinux\nAlpine\nAndroid\nDebian\nnpm\nRed Hat\n[EMPTY]\n";

function downloader(csv = ""): OsvDownloader {
    return {
        download: vi.fn(async (url: string) => {
            if (url.endsWith("/ecosystems.txt")) return { data: Buffer.from(ECOSYSTEMS_TXT) };
            throw new Error(`unexpected download ${url}`);
        }),
        downloadMany: vi.fn().mockResolvedValue(new Map()),
        streamLines: vi.fn(() => linesOf(csv)),
        computeSha256: vi.fn().mockReturnValue(Buffer.alloc(32)),
    } as unknown as OsvDownloader;
}

function record(id: string): ParsedOsvRecord {
    return {
        id,
        modified: new Date("2026-10-01T00:00:00Z"),
        published: undefined,
        withdrawn: undefined,
        raw: { id, modified: "2026-10-01T00:00:00Z", affected: [] },
        rawSha256: Buffer.alloc(32),
        validationErrors: [],
        severity: null,
    };
}

/**
 * A zip processor that serves a fixed set of entries per archive URL and
 * honours `filter` the way the real one does — before "inflating".
 */
function zipProcessor(archives: Record<string, string[]>): ZipProcessor & { urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        processZip: vi.fn(
            async (
                url: string,
                onRecord: (record: ParsedOsvRecord, entry: ZipEntryInfo) => Promise<void>,
                options?: ZipProcessOptions,
            ) => {
                urls.push(url);
                const ids = archives[url];
                if (!ids) throw new Error(`404 ${url}`);
                let processedCount = 0;
                for (const id of ids) {
                    const dir = decodeURIComponent(url.slice("https://osv.example/".length, -"/all.zip".length));
                    const entry: ZipEntryInfo = { path: `${dir}/${id}.json`, ecosystemDir: dir, vulnId: id };
                    if (options?.filter && !options.filter(entry)) continue;
                    await onRecord(record(id), entry);
                    processedCount++;
                }
                return {
                    processedCount,
                    errorCount: 0,
                    maxModifiedTimestamp: new Date("2026-10-01T00:00:00Z"),
                    errors: [],
                };
            },
        ),
    };
}

function affectedPkgRepo(): OsvAffectedPackageRepository {
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

function build(opts: {
    ecosystems: string[] | null;
    state?: OsvSyncState;
    archives?: Record<string, string[]>;
    csv?: string;
}): { worker: OsvSyncWorker; sm: SyncStateManager; zip: ReturnType<typeof zipProcessor>; dl: OsvDownloader } {
    const sm = stateManager(opts.state ?? stateRow());
    const zip = zipProcessor(opts.archives ?? {});
    const dl = downloader(opts.csv);
    const worker = createOsvSyncWorker(
        config(opts.ecosystems),
        sm,
        dl,
        zip,
        affectedPkgRepo(),
        {
            bulkInsert: vi.fn().mockResolvedValue(0),
            deleteOlderThan: vi.fn().mockResolvedValue(0),
        } as unknown as OsvSyncFailureRepository,
        { insert: vi.fn().mockResolvedValue(undefined) } as OsvSyncRunRepository,
    );
    return { worker, sm, zip, dl };
}

describe("scoped bootstrap", () => {
    beforeEach(() => vi.clearAllMocks());

    it("pulls one archive per configured ecosystem, in order, and never the global all.zip", async () => {
        const { worker, sm, zip } = build({
            ecosystems: ["Alpine", "Red Hat"],
            archives: {
                "https://osv.example/Alpine/all.zip": ["ALPINE-CVE-2026-1"],
                "https://osv.example/Red%20Hat/all.zip": ["RHSA-2026:1"],
            },
        });

        const result = await worker.forceFullRefresh();

        expect(result.success).toBe(true);
        expect(zip.urls).toEqual(["https://osv.example/Alpine/all.zip", "https://osv.example/Red%20Hat/all.zip"]);
        expect(result.recordsProcessed).toBe(2);
        // The published generation records what it was built from.
        expect(sm.markInitialized).toHaveBeenCalledWith(expect.any(Date), ["Alpine", "Red Hat"]);
    });

    it("still bootstraps from all.zip when unscoped, recording an unscoped mirror", async () => {
        const { worker, sm, zip } = build({
            ecosystems: null,
            archives: { "https://osv.example/all.zip": ["CVE-2026-1"] },
        });

        const result = await worker.forceFullRefresh();

        expect(result.success).toBe(true);
        expect(zip.urls).toEqual(["https://osv.example/all.zip"]);
        expect(sm.markInitialized).toHaveBeenCalledWith(expect.any(Date), null);
    });

    it("refuses a name OSV does not publish before downloading anything, naming it", async () => {
        const { worker, sm, zip } = build({
            ecosystems: ["Alpine", "RedHat"],
            archives: { "https://osv.example/Alpine/all.zip": ["ALPINE-CVE-2026-1"] },
        });

        const result = await worker.forceFullRefresh();

        expect(result.success).toBe(false);
        expect(result.errors.join(" ")).toMatch(/RedHat/);
        expect(result.errors.join(" ")).toMatch(/ecosystems\.txt/);
        expect(zip.urls).toEqual([]);
        expect(sm.markInitialized).not.toHaveBeenCalled();
    });

    it("takes a cross-listed advisory once: the second archive's copy is filtered by path", async () => {
        const { worker, zip } = build({
            ecosystems: ["npm", "Debian"],
            archives: {
                "https://osv.example/npm/all.zip": ["GHSA-aaaa", "GHSA-bbbb"],
                "https://osv.example/Debian/all.zip": ["GHSA-aaaa", "DSA-1"],
            },
        });

        const result = await worker.forceFullRefresh();

        expect(result.success).toBe(true);
        expect(result.recordsProcessed).toBe(3);
        // The Debian archive was asked to skip the record npm delivered, by
        // path, and nothing else. (Checked after the run, so every delivered
        // id is "seen" by now; an id no archive carried is the clean probe.)
        const debianCall = vi.mocked(zip.processZip).mock.calls[1]!;
        const filter = debianCall[2]!.filter!;
        expect(filter({ path: "Debian/GHSA-aaaa.json", ecosystemDir: "Debian", vulnId: "GHSA-aaaa" })).toBe(false);
        expect(
            filter({ path: "Debian/DSA-never-delivered.json", ecosystemDir: "Debian", vulnId: "DSA-never-delivered" }),
        ).toBe(true);
    });

    it("fails the run when one ecosystem's archive cannot be fetched — a skipped ecosystem would be a permanent hole", async () => {
        const { worker, sm } = build({
            ecosystems: ["Alpine", "Debian"],
            archives: { "https://osv.example/Alpine/all.zip": ["ALPINE-CVE-2026-1"] },
        });

        const result = await worker.forceFullRefresh();

        expect(result.success).toBe(false);
        expect(result.errors.join(" ")).toMatch(/Debian/);
        expect(sm.markInitialized).not.toHaveBeenCalled();
    });
});

describe("scoped incremental sync", () => {
    beforeEach(() => vi.clearAllMocks());

    const csv = [
        "2026-10-02T00:00:00Z,Alpine/ALPINE-CVE-2026-9",
        "2026-10-02T00:00:00Z,Android/ASB-A-1",
        "2026-10-02T00:00:00Z,Android/GHSA-cross",
        "2026-10-02T00:00:00Z,npm/GHSA-cross",
    ].join("\n");

    it("ignores entries outside the scope, keeping a cross-listed record through its in-scope path", async () => {
        const { worker, dl } = build({ ecosystems: ["Alpine", "npm"], csv });

        const result = await worker.runCycle();

        expect(result.success).toBe(true);
        const [entries] = vi.mocked(dl.downloadMany).mock.calls[0]! as unknown as [
            Array<{ vulnId: string; ecosystemDir: string }>,
        ];
        expect(entries.map((e) => `${e.ecosystemDir}/${e.vulnId}`).sort()).toEqual([
            "Alpine/ALPINE-CVE-2026-9",
            "npm/GHSA-cross",
        ]);
    });

    it("fetches everything when unscoped", async () => {
        const { worker, dl } = build({ ecosystems: null, csv });

        await worker.runCycle();

        const [entries] = vi.mocked(dl.downloadMany).mock.calls[0]! as unknown as [Array<{ vulnId: string }>];
        expect(entries).toHaveLength(3); // GHSA-cross deduplicated across its two directories
    });
});

describe("bootstrap-if-needed and the mirror's scope", () => {
    beforeEach(() => vi.clearAllMocks());

    it("is a no-op when the mirror covers the configured ecosystems", async () => {
        const { worker, sm } = build({
            ecosystems: ["Alpine"],
            state: stateRow({ ecosystems: ["Alpine", "Debian"] }),
        });
        const result = await worker.bootstrapIfNeeded();
        expect(result.noop).toBe(true);
        expect(sm.tryAcquireAdvisoryLock).not.toHaveBeenCalled();
    });

    it("treats an unscoped mirror as covering any scope", async () => {
        const { worker } = build({ ecosystems: ["Alpine"], state: stateRow({ ecosystems: null }) });
        expect((await worker.bootstrapIfNeeded()).noop).toBe(true);
    });

    it("rebuilds when OSV_ECOSYSTEMS was widened after the last bootstrap", async () => {
        const { worker, sm, zip } = build({
            ecosystems: ["Alpine", "Debian"],
            state: stateRow({ ecosystems: ["Alpine"] }),
            archives: {
                "https://osv.example/Alpine/all.zip": ["ALPINE-CVE-2026-1"],
                "https://osv.example/Debian/all.zip": ["DSA-1"],
            },
        });

        const result = await worker.bootstrapIfNeeded();

        expect(result.noop).toBeUndefined();
        expect(result.success).toBe(true);
        expect(zip.urls).toHaveLength(2);
        expect(sm.markInitialized).toHaveBeenCalledWith(expect.any(Date), ["Alpine", "Debian"]);
    });

    it("rebuilds when a scoped mirror is asked for everything", async () => {
        const { worker, zip } = build({
            ecosystems: null,
            state: stateRow({ ecosystems: ["Alpine"] }),
            archives: { "https://osv.example/all.zip": ["CVE-2026-1"] },
        });

        const result = await worker.bootstrapIfNeeded();

        expect(result.success).toBe(true);
        expect(zip.urls).toEqual(["https://osv.example/all.zip"]);
    });
});
