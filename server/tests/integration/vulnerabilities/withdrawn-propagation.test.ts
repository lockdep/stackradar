/**
 * Withdrawn propagation through an incremental sync.
 *
 * `vulnerability_affected_packages.withdrawn` is denormalized from the OSV
 * record so the matcher's hot lookup needs no join. Denormalized data goes
 * stale silently, and a stale `false` here is a false positive on a retracted
 * advisory — the one failure mode no other test would catch by accident. So
 * this exercises the real path: run an incremental sync that serves an active
 * advisory, then run another that serves the same advisory withdrawn, and read
 * the flag back out of the database.
 *
 * The sync is driven through `runIncremental` with a stub downloader and real
 * repositories, rather than through the parser alone, because the thing under
 * test is `replaceForVulns` re-deriving the flag — not `extractAffectedPackages`
 * computing it, which the unit tests already cover.
 */

import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";

import { getTestDb, getTestPgClient, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import type { DownloadResult, OsvDownloader } from "../../../src/osv-sync/downloader.js";
import type { SyncPhaseDeps } from "../../../src/osv-sync/types.js";
import type { ZipProcessor } from "../../../src/osv-sync/zip-processor.js";

// ---------------------------------------------------------------------------
// Lazily populated after DATABASE_URL is set by test-setup.ts beforeAll
// ---------------------------------------------------------------------------

let runIncremental: typeof import("../../../src/osv-sync/incremental.js").runIncremental;
let createSyncStateManager: typeof import("../../../src/osv-sync/state.js").createSyncStateManager;
let createOsvAffectedPackageRepository: typeof import("../../../src/osv-sync/affected-package-repository.js").createOsvAffectedPackageRepository;
let createOsvSyncFailureRepository: typeof import("../../../src/osv-sync/failure-repository.js").createOsvSyncFailureRepository;
let createOsvSyncRunRepository: typeof import("../../../src/osv-sync/run-repository.js").createOsvSyncRunRepository;
let loadConfig: typeof import("../../../src/osv-sync/config.js").loadConfig;

beforeAll(async () => {
    // Dynamic imports must happen AFTER test-setup.ts beforeAll sets DATABASE_URL,
    // otherwise db/index.ts initialises with the fallback localhost:5444 URL.
    runIncremental = (await import("../../../src/osv-sync/incremental.js")).runIncremental;
    createSyncStateManager = (await import("../../../src/osv-sync/state.js")).createSyncStateManager;
    createOsvAffectedPackageRepository = (
        await import("../../../src/osv-sync/affected-package-repository.js")
    ).createOsvAffectedPackageRepository;
    createOsvSyncFailureRepository = (
        await import("../../../src/osv-sync/failure-repository.js")
    ).createOsvSyncFailureRepository;
    createOsvSyncRunRepository = (
        await import("../../../src/osv-sync/run-repository.js")
    ).createOsvSyncRunRepository;
    loadConfig = (await import("../../../src/osv-sync/config.js")).loadConfig;
});

// ---------------------------------------------------------------------------
// A downloader that serves one advisory from memory
// ---------------------------------------------------------------------------

const VULN_ID = "GHSA-test-withdrawn";
const ECOSYSTEM_DIR = "npm";

function osvRecord(options: {
    modified: string;
    withdrawn?: string;
    affected?: unknown[];
}): Record<string, unknown> {
    const record: Record<string, unknown> = {
        id: VULN_ID,
        schema_version: "1.6.0",
        modified: options.modified,
        published: "2024-01-01T00:00:00Z",
        summary: "Synthetic advisory for withdrawn-propagation tests",
        affected: options.affected ?? [
            {
                package: { name: "lodash", ecosystem: "npm", purl: "pkg:npm/lodash" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
            },
            {
                package: { name: "underscore", ecosystem: "npm", purl: "pkg:npm/underscore" },
                ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.13.0" }] }],
            },
        ],
    };

    if (options.withdrawn) record.withdrawn = options.withdrawn;

    return record;
}

/**
 * Serves modified_id.csv listing the one advisory, and the advisory JSON for
 * any record URL. Everything the incremental path does not call throws, so a
 * future change that starts reaching for the network fails loudly here.
 */
function stubDownloader(record: Record<string, unknown>, modified: string): OsvDownloader {
    const csv = `modified,path\n${modified},${ECOSYSTEM_DIR}/${VULN_ID}\n`;
    const json = Buffer.from(JSON.stringify(record), "utf8");

    const result = (data: Buffer): DownloadResult => ({
        data,
        etag: undefined,
        lastModified: undefined,
        contentLength: data.length,
    });

    return {
        async download(): Promise<DownloadResult> {
            return result(Buffer.from(csv, "utf8"));
        },
        async *streamLines(): AsyncGenerator<string> {
            for (const line of csv.split("\n")) yield line;
        },
        async downloadMany<T>(items: T[]): Promise<Map<T, DownloadResult | Error>> {
            return new Map(items.map((item) => [item, result(json)]));
        },
        async streamDownload(): Promise<never> {
            throw new Error("streamDownload is not used by the incremental path");
        },
        computeSha256(data: Buffer): Buffer {
            // The sync only compares this to the previously stored hash for
            // equality, so any stable digest of the bytes will do.
            return createHash("sha256").update(data).digest();
        },
    };
}

function makeDeps(record: Record<string, unknown>, modified: string): SyncPhaseDeps {
    const db = getTestDb();

    return {
        config: loadConfig(),
        stateManager: createSyncStateManager(db, getTestPgClient()),
        downloader: stubDownloader(record, modified),
        // The incremental path never touches the zip processor; it only exists
        // on SyncPhaseDeps for the bootstrap path.
        zipProcessor: {} as ZipProcessor,
        affectedPkgRepository: createOsvAffectedPackageRepository(db),
        failureRepository: createOsvSyncFailureRepository(db),
        runRepository: createOsvSyncRunRepository(db),
    };
}

async function syncWith(record: Record<string, unknown>, modified: string) {
    const result = await runIncremental(makeDeps(record, modified));
    expect(result.errors, "sync should not report errors").toEqual([]);
    expect(result.success).toBe(true);
    return result;
}

// ---------------------------------------------------------------------------
// Reading the rows back
// ---------------------------------------------------------------------------

type AffectedRow = Record<string, unknown> & {
    package_name: string;
    withdrawn: boolean;
    match_key: string;
};

async function affectedRows(): Promise<AffectedRow[]> {
    const db = getTestDb();
    return db.execute<AffectedRow>(sql`
        SELECT ap.package_name, ap.withdrawn, ap.match_key
        FROM vulnerability_affected_packages ap
        JOIN vulnerabilities v ON v.id = ap.vulnerability_id
        WHERE v.vuln_id = ${VULN_ID}
        ORDER BY ap.package_name
    `);
}

/** `vulnerabilities.withdrawn_at`, the column the flag is denormalized from. */
async function withdrawnAt(): Promise<Date | null> {
    const db = getTestDb();
    const [row] = await db
        .select({ withdrawnAt: schema.vulnerabilities.withdrawnAt })
        .from(schema.vulnerabilities)
        .where(eq(schema.vulnerabilities.vulnId, VULN_ID));
    return row?.withdrawnAt ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withdrawn propagation through an incremental sync", () => {
    beforeEach(async () => {
        await cleanAllData();

        const db = getTestDb();
        await db.delete(schema.osvSyncRuns);
        await db.delete(schema.osvSyncFailures);
        await db.delete(schema.osvSyncState);
        // A watermark well before the advisories below, so both syncs see their
        // record as a candidate rather than filtering it out.
        await db.insert(schema.osvSyncState).values({
            id: 1,
            initialized: true,
            lastModifiedApplied: new Date("2024-01-01T00:00:00Z"),
        });
    });

    it("stores withdrawn = false for an active advisory", async () => {
        await syncWith(osvRecord({ modified: "2024-06-01T00:00:00Z" }), "2024-06-01T00:00:00Z");

        const rows = await affectedRows();
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.package_name)).toEqual(["lodash", "underscore"]);
        expect(rows.every((r) => r.withdrawn === false)).toBe(true);
    });

    it("flips withdrawn to true on every affected row when a later sync withdraws the advisory", async () => {
        await syncWith(osvRecord({ modified: "2024-06-01T00:00:00Z" }), "2024-06-01T00:00:00Z");
        expect((await affectedRows()).every((r) => r.withdrawn === false)).toBe(true);

        await syncWith(
            osvRecord({ modified: "2024-08-15T14:30:00Z", withdrawn: "2024-08-15T14:30:00Z" }),
            "2024-08-15T14:30:00Z"
        );

        const rows = await affectedRows();
        // Replaced, not appended — replaceForVulns deletes before inserting.
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.withdrawn === true)).toBe(true);

        // And the flag agrees with the column it is denormalized from.
        expect(await withdrawnAt()).toEqual(new Date("2024-08-15T14:30:00Z"));
    });

    it("clears withdrawn again if the advisory is un-withdrawn", async () => {
        await syncWith(
            osvRecord({ modified: "2024-08-15T14:30:00Z", withdrawn: "2024-08-15T14:30:00Z" }),
            "2024-08-15T14:30:00Z"
        );
        expect((await affectedRows()).every((r) => r.withdrawn === true)).toBe(true);

        await syncWith(osvRecord({ modified: "2024-09-01T00:00:00Z" }), "2024-09-01T00:00:00Z");

        const rows = await affectedRows();
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.withdrawn === false)).toBe(true);
        expect(await withdrawnAt()).toBeNull();
    });

    it("deletes the old rows when a re-synced advisory has no affected entries left", async () => {
        await syncWith(osvRecord({ modified: "2024-06-01T00:00:00Z" }), "2024-06-01T00:00:00Z");
        expect(await affectedRows()).toHaveLength(2);

        await syncWith(
            osvRecord({ modified: "2024-09-01T00:00:00Z", affected: [] }),
            "2024-09-01T00:00:00Z"
        );

        // Rows with nothing behind them are permanently stale candidates; the
        // replace has to run even when the incoming batch is empty.
        expect(await affectedRows()).toHaveLength(0);
    });

    it("writes the canonical match key alongside the flag", async () => {
        await syncWith(osvRecord({ modified: "2024-06-01T00:00:00Z" }), "2024-06-01T00:00:00Z");

        expect((await affectedRows()).map((r) => r.match_key)).toEqual([
            "npm|lodash",
            "npm|underscore",
        ]);
    });
});
