import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getTestDb } from "../../setup/test-db.js";
import {
    createOsvSyncFailureRepository,
    type OsvSyncFailureRepository,
} from "../../../src/osv-sync/failure-repository.js";
import type { NewOsvSyncFailure } from "../../../src/db/schema/osv-mirror.js";

function createTestFailure(overrides: Partial<NewOsvSyncFailure> = {}): NewOsvSyncFailure {
    return {
        syncRunId: overrides.syncRunId ?? randomUUID(),
        syncMode: overrides.syncMode ?? "incremental",
        osvId: "osvId" in overrides ? (overrides.osvId ?? null) : "CVE-2024-1234",
        ecosystemDir: "ecosystemDir" in overrides ? (overrides.ecosystemDir ?? null) : "PyPI",
        sourcePath: overrides.sourcePath ?? "PyPI/CVE-2024-1234.json",
        errorType: overrides.errorType ?? "parse_error",
        errorMessage: overrides.errorMessage ?? "Invalid JSON",
    };
}

/**
 * Direct-SQL probe over osv_sync_failures, insertion-ordered. Replaces the
 * deleted repository read methods that no production code called — the admin
 * surface queries this table directly.
 */
async function rowsForRun(db: ReturnType<typeof getTestDb>, runId: string) {
    return db.execute<{
        sync_run_id: string;
        sync_mode: string;
        osv_id: string | null;
        ecosystem_dir: string | null;
        source_path: string;
        error_type: string;
        error_message: string;
        occurred_at: string;
    }>(sql`
        SELECT sync_run_id, sync_mode, osv_id, ecosystem_dir, source_path,
               error_type, error_message, occurred_at
        FROM osv_sync_failures
        WHERE sync_run_id = ${runId}
        ORDER BY id
    `);
}

describe("OsvSyncFailureRepository", () => {
    let db: ReturnType<typeof getTestDb>;
    let repository: OsvSyncFailureRepository;

    beforeAll(() => {
        db = getTestDb();
        repository = createOsvSyncFailureRepository(db);
    });

    beforeEach(async () => {
        await db.execute(sql`TRUNCATE TABLE osv_sync_failures`);
    });

    describe("bulkInsert", () => {
        it("should insert multiple failure records", async () => {
            const runId = randomUUID();
            const failures = [
                createTestFailure({ syncRunId: runId, osvId: "CVE-2024-001", sourcePath: "npm/CVE-2024-001.json" }),
                createTestFailure({ syncRunId: runId, osvId: "CVE-2024-002", sourcePath: "npm/CVE-2024-002.json" }),
                createTestFailure({ syncRunId: runId, osvId: "CVE-2024-003", sourcePath: "npm/CVE-2024-003.json" }),
            ];

            const count = await repository.bulkInsert(failures);

            expect(count).toBe(3);

            const total = await repository.getCount();
            expect(total).toBe(3);
        });

        it("should return 0 for empty array", async () => {
            const count = await repository.bulkInsert([]);
            expect(count).toBe(0);
        });

        it("should handle nullable osvId and ecosystemDir", async () => {
            const runId = randomUUID();
            const failure = createTestFailure({
                syncRunId: runId,
                osvId: null,
                ecosystemDir: null,
                sourcePath: "corrupt-file.json",
                errorMessage: "Unexpected token in JSON",
            });

            await repository.bulkInsert([failure]);

            const results = await rowsForRun(db, runId);
            expect(results).toHaveLength(1);
            expect(results[0]!.osv_id).toBeNull();
            expect(results[0]!.ecosystem_dir).toBeNull();
            expect(results[0]!.source_path).toBe("corrupt-file.json");
        });

        it("should preserve all fields correctly", async () => {
            const runId = randomUUID();
            await repository.bulkInsert([
                createTestFailure({
                    syncRunId: runId,
                    syncMode: "initialization",
                    osvId: "GHSA-xxxx",
                    ecosystemDir: "Maven",
                    sourcePath: "Maven/GHSA-xxxx.json",
                    errorType: "download_error",
                    errorMessage: "HTTP 404 Not Found",
                }),
            ]);

            const results = await rowsForRun(db, runId);
            const row = results[0]!;

            expect(row.sync_run_id).toBe(runId);
            expect(row.sync_mode).toBe("initialization");
            expect(row.osv_id).toBe("GHSA-xxxx");
            expect(row.ecosystem_dir).toBe("Maven");
            expect(row.source_path).toBe("Maven/GHSA-xxxx.json");
            expect(row.error_type).toBe("download_error");
            expect(row.error_message).toBe("HTTP 404 Not Found");
            expect(new Date(row.occurred_at).getTime()).not.toBeNaN();
        });
    });

    describe("deleteOlderThan", () => {
        it("should delete failures older than the given date", async () => {
            const runId = randomUUID();

            await repository.bulkInsert([
                createTestFailure({ syncRunId: runId, osvId: "OLD-1" }),
                createTestFailure({ syncRunId: runId, osvId: "OLD-2" }),
            ]);

            // Delete everything older than 1 second in the future
            const futureDate = new Date(Date.now() + 1000);
            await repository.deleteOlderThan(futureDate);

            const count = await repository.getCount();
            expect(count).toBe(0);
        });

        it("should not delete recent failures", async () => {
            await repository.bulkInsert([createTestFailure()]);

            // Delete only failures older than the past
            const pastDate = new Date("2020-01-01");
            await repository.deleteOlderThan(pastDate);

            const count = await repository.getCount();
            expect(count).toBe(1);
        });
    });

    describe("getCount", () => {
        it("should return 0 for empty table", async () => {
            const count = await repository.getCount();
            expect(count).toBe(0);
        });

        it("should return total failure count across runs", async () => {
            await repository.bulkInsert([
                createTestFailure({ syncRunId: randomUUID() }),
                createTestFailure({ syncRunId: randomUUID() }),
                createTestFailure({ syncRunId: randomUUID() }),
            ]);

            const count = await repository.getCount();
            expect(count).toBe(3);
        });
    });
});
