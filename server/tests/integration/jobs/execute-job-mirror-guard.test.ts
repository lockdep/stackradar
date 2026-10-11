/**
 * jobService.executeJob — OSV mirror sync guard tests
 *
 * Verifies that when OsvMirrorNotReadyError is thrown during job
 * execution, executeJob re-queues the job to pending instead of failing it.
 * Also verifies that regular errors still fail the job as expected.
 *
 * All service/repository imports are dynamic (inside beforeAll) because
 * db/index.ts initialises its connection from DATABASE_URL at module-eval
 * time — before the setupFiles beforeAll hook sets that variable.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { Job } from "../../../src/db/schema/jobs.js";

type JobService = typeof import("../../../src/services/job.service.js").jobService;
type JobRepository = typeof import("../../../src/repositories/job.repository.js").jobRepository;
type VulnSyncService = typeof import("../../../src/services/vulnerability-sync.service.js").vulnerabilitySyncService;
type OsvMirrorNotReadyErrorClass =
    typeof import("../../../src/services/vulnerability-sync.service.js").OsvMirrorNotReadyError;

let jobService: JobService;
let jobRepository: JobRepository;
let vulnerabilitySyncService: VulnSyncService;
let OsvMirrorNotReadyError: OsvMirrorNotReadyErrorClass;

beforeAll(async () => {
    const jobMod = await import("../../../src/services/job.service.js");
    jobService = jobMod.jobService;

    const jobRepoMod = await import("../../../src/repositories/job.repository.js");
    jobRepository = jobRepoMod.jobRepository;

    const syncMod = await import("../../../src/services/vulnerability-sync.service.js");
    vulnerabilitySyncService = syncMod.vulnerabilitySyncService;
    OsvMirrorNotReadyError = syncMod.OsvMirrorNotReadyError;
});

describe("jobService.executeJob — OSV mirror sync guard", () => {
    let testData: SeedTestScenarioResult;

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function insertProcessingJob(overrides: Partial<typeof schema.jobs.$inferInsert> = {}): Promise<Job> {
        const db = getTestDb();
        const [job] = await db
            .insert(schema.jobs)
            .values({
                orgId: testData.org.id,
                type: "vulnerability_scan",
                title: "Test Scan",
                triggeredBy: "manual",
                status: "processing",
                startedAt: new Date(),
                progress: 10,
                progressMessage: "Fetching components...",
                ...overrides,
            })
            .returning();
        return job!;
    }

    // ── Re-queue on OsvMirrorNotReadyError ──────────────────────────────

    it("re-queues a vulnerability_scan job to pending when the mirror is not ready", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const job = await insertProcessingJob({ imageId: image.id });

        vi.spyOn(vulnerabilitySyncService, "syncImageVulnerabilities").mockRejectedValue(
            new OsvMirrorNotReadyError("idle"),
        );

        await jobService.executeJob(job);

        const updated = await jobRepository.findById(job.id);
        expect(updated!.status).toBe("pending");
        expect(updated!.progress).toBe(0);
        expect(updated!.progressMessage).toBeNull();
        expect(updated!.startedAt).toBeNull();
        expect(updated!.errorCode).toBeNull();
        expect(updated!.errorMessage).toBeNull();
    });

    it("re-queues a scheduled_scan job to pending when the mirror is not ready", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const job = await insertProcessingJob({ type: "scheduled_scan", imageId: image.id });

        vi.spyOn(vulnerabilitySyncService, "syncImageVulnerabilities").mockRejectedValue(
            new OsvMirrorNotReadyError("idle"),
        );

        await jobService.executeJob(job);

        const updated = await jobRepository.findById(job.id);
        expect(updated!.status).toBe("pending");
        expect(updated!.errorCode).toBeNull();
    });

    it("re-queues a full_sync job to pending when the mirror is not ready", async () => {
        const job = await insertProcessingJob({ type: "full_sync" });

        vi.spyOn(vulnerabilitySyncService, "syncAllComponentsVulnerabilities").mockRejectedValue(
            new OsvMirrorNotReadyError("idle"),
        );

        await jobService.executeJob(job);

        const updated = await jobRepository.findById(job.id);
        expect(updated!.status).toBe("pending");
        expect(updated!.progress).toBe(0);
        expect(updated!.errorCode).toBeNull();
    });

    it("does not increment retryCount when re-queuing a deferred job", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const job = await insertProcessingJob({ imageId: image.id });

        vi.spyOn(vulnerabilitySyncService, "syncImageVulnerabilities").mockRejectedValue(
            new OsvMirrorNotReadyError("idle"),
        );

        await jobService.executeJob(job);

        const updated = await jobRepository.findById(job.id);
        // Deferral is not a failure — retryCount must not increase
        expect(updated!.retryCount).toBe(0);
    });

    // ── Normal error path still fails the job ────────────────────────────────

    it("fails the job on a regular error", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const job = await insertProcessingJob({ imageId: image.id });

        vi.spyOn(vulnerabilitySyncService, "syncImageVulnerabilities").mockRejectedValue(
            new Error("unexpected DB error"),
        );

        await jobService.executeJob(job);

        const updated = await jobRepository.findById(job.id);
        expect(updated!.status).toBe("failed");
        expect(updated!.errorCode).toBe("PROCESSING_ERROR");
        expect(updated!.errorMessage).toContain("unexpected DB error");
    });
});
