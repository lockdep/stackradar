import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import type { Job, NewJob, Image } from "../../../src/db/schema/index.js";
import * as schema from "../../../src/db/schema/index.js";
import type { jobRepository as JobRepositoryType } from "../../../src/repositories/job.repository.js";

describe("jobRepository.findLatestVulnScanForImage", () => {
    let testData: SeedTestScenarioResult;
    let image: Image;
    let jobRepository: typeof JobRepositoryType;

    beforeAll(async () => {
        const mod = await import("../../../src/repositories/job.repository.js");
        jobRepository = mod.jobRepository;
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
        image = await createImage(db, testData.org.id, testData.cluster.id);
    });

    async function insertJob(overrides: Partial<NewJob> = {}): Promise<Job> {
        const db = getTestDb();
        const [job] = await db
            .insert(schema.jobs)
            .values({
                orgId: testData.org.id,
                imageId: image.id,
                type: "vulnerability_scan",
                title: "Test Job",
                triggeredBy: "manual",
                status: "completed",
                completedAt: new Date(),
                ...overrides,
            })
            .returning();
        return job!;
    }

    it("returns undefined when the image has no scan jobs", async () => {
        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result).toBeUndefined();
    });

    it("finds a completed manual vulnerability_scan", async () => {
        const job = await insertJob({ type: "vulnerability_scan" });
        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result?.id).toBe(job.id);
    });

    // Regression: a completed scheduled_scan must count as a scan so the
    // Vulnerabilities tab doesn't show "No vulnerability scan has been run".
    it("finds a completed scheduled_scan", async () => {
        const job = await insertJob({ type: "scheduled_scan" });
        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result?.id).toBe(job.id);
    });

    it("ignores non-scan job types", async () => {
        await insertJob({ type: "full_sync" });
        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result).toBeUndefined();
    });

    it("returns the most recent scan across both scan types", async () => {
        await insertJob({
            type: "vulnerability_scan",
            createdAt: new Date(Date.now() - 60_000),
        });
        const newer = await insertJob({
            type: "scheduled_scan",
            createdAt: new Date(),
        });
        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result?.id).toBe(newer.id);
    });

    // Regression: a future-scheduled recurring scan (status "scheduled") must
    // not mask an already-completed scan, or the tab would wrongly report the
    // scan as still queued.
    it("ignores future-scheduled placeholder scans", async () => {
        const completed = await insertJob({
            type: "vulnerability_scan",
            status: "completed",
            completedAt: new Date(),
            createdAt: new Date(Date.now() - 60_000),
        });
        await insertJob({
            type: "scheduled_scan",
            status: "scheduled",
            completedAt: null,
            scheduledFor: new Date(Date.now() + 3_600_000),
            createdAt: new Date(),
        });

        const result = await jobRepository.findLatestVulnScanForImage(image.id);
        expect(result?.id).toBe(completed.id);
    });
});
