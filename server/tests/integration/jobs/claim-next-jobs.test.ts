import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createImage, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import type { Job, NewJob } from "../../../src/db/schema/jobs.js";
import * as schema from "../../../src/db/schema/index.js";
import type { jobRepository as JobRepositoryType } from "../../../src/repositories/job.repository.js";

describe("jobRepository.claimNextJobs", () => {
    let testData: SeedTestScenarioResult;
    let jobRepository: typeof JobRepositoryType;

    beforeAll(async () => {
        const mod = await import("../../../src/repositories/job.repository.js");
        jobRepository = mod.jobRepository;
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
    });

    async function insertJob(overrides: Partial<NewJob> = {}): Promise<Job> {
        const db = getTestDb();
        const [job] = await db
            .insert(schema.jobs)
            .values({
                orgId: testData.org.id,
                type: "vulnerability_scan",
                title: "Test Job",
                triggeredBy: "manual",
                status: "pending",
                ...overrides,
            })
            .returning();
        return job!;
    }

    it("should return empty array when no jobs are ready", async () => {
        const claimed = await jobRepository.claimNextJobs(5);
        expect(claimed).toEqual([]);
    });

    it("should claim pending jobs with no scheduled_for", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const job = await insertJob({ imageId: image.id });

        const claimed = await jobRepository.claimNextJobs(5);

        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.id).toBe(job.id);
        expect(claimed[0]!.status).toBe("processing");
        expect(claimed[0]!.startedAt).toBeInstanceOf(Date);
    });

    it("should claim scheduled jobs whose scheduled_for is in the past", async () => {
        const pastDate = new Date(Date.now() - 60_000);
        const job = await insertJob({
            status: "scheduled",
            scheduledFor: pastDate,
        });

        const claimed = await jobRepository.claimNextJobs(5);

        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.id).toBe(job.id);
        expect(claimed[0]!.status).toBe("processing");
    });

    it("should skip scheduled jobs whose scheduled_for is in the future", async () => {
        const futureDate = new Date(Date.now() + 3_600_000);
        await insertJob({
            status: "scheduled",
            scheduledFor: futureDate,
        });

        const claimed = await jobRepository.claimNextJobs(5);
        expect(claimed).toEqual([]);
    });

    it("should skip jobs that are already processing", async () => {
        await insertJob({ status: "processing", startedAt: new Date() });

        const claimed = await jobRepository.claimNextJobs(5);
        expect(claimed).toEqual([]);
    });

    it("should skip completed and failed jobs", async () => {
        await insertJob({ status: "completed", completedAt: new Date() });
        await insertJob({ status: "failed", completedAt: new Date() });

        const claimed = await jobRepository.claimNextJobs(5);
        expect(claimed).toEqual([]);
    });

    it("should respect the limit parameter", async () => {
        await insertJob({ title: "Job 1" });
        await insertJob({ title: "Job 2" });
        await insertJob({ title: "Job 3" });

        const claimed = await jobRepository.claimNextJobs(2);
        expect(claimed).toHaveLength(2);
    });

    it("should claim highest-priority jobs first when limit is constrained", async () => {
        const lowPriority = await insertJob({ title: "Low priority", priority: 1 });
        const highPriority = await insertJob({ title: "High priority", priority: 10 });
        await insertJob({ title: "Medium priority", priority: 5 });

        const claimed = await jobRepository.claimNextJobs(2);

        expect(claimed).toHaveLength(2);
        const claimedIds = claimed.map((j) => j.id);
        expect(claimedIds).toContain(highPriority.id);
        expect(claimedIds).not.toContain(lowPriority.id);
    });

    it("should set startedAt and updatedAt on claimed jobs", async () => {
        const before = new Date();
        await insertJob();

        const claimed = await jobRepository.claimNextJobs(5);

        expect(claimed).toHaveLength(1);
        expect(claimed[0]!.startedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
        expect(claimed[0]!.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it("should not re-claim jobs on a second call", async () => {
        await insertJob();

        const first = await jobRepository.claimNextJobs(5);
        expect(first).toHaveLength(1);

        const second = await jobRepository.claimNextJobs(5);
        expect(second).toEqual([]);
    });

    it("should handle mixed ready and not-ready jobs", async () => {
        const pendingJob = await insertJob({ title: "Pending" });
        const pastScheduled = await insertJob({
            title: "Past scheduled",
            status: "scheduled",
            scheduledFor: new Date(Date.now() - 60_000),
        });
        await insertJob({
            title: "Future scheduled",
            status: "scheduled",
            scheduledFor: new Date(Date.now() + 3_600_000),
        });
        await insertJob({ title: "Already processing", status: "processing", startedAt: new Date() });
        await insertJob({ title: "Already done", status: "completed", completedAt: new Date() });

        const claimed = await jobRepository.claimNextJobs(10);

        expect(claimed).toHaveLength(2);
        const claimedIds = claimed.map((j) => j.id);
        expect(claimedIds).toContain(pendingJob.id);
        expect(claimedIds).toContain(pastScheduled.id);
    });

    it("should claim across multiple organizations", async () => {
        const db = getTestDb();
        const otherScenario = await seedTestScenario(db, { email: "other@test.com" }, { name: "Other Org" });
        await insertJob({ orgId: testData.org.id, title: "Org 1 job" });
        await insertJob({ orgId: otherScenario.org.id, title: "Org 2 job" });

        const claimed = await jobRepository.claimNextJobs(10);

        expect(claimed).toHaveLength(2);
        const orgIds = claimed.map((j) => j.orgId);
        expect(orgIds).toContain(testData.org.id);
        expect(orgIds).toContain(otherScenario.org.id);
    });

    it("should handle concurrent claims without double-claiming (FOR UPDATE SKIP LOCKED)", async () => {
        for (let i = 0; i < 6; i++) {
            await insertJob({ title: `Job ${i}`, priority: i });
        }

        const [batch1, batch2] = await Promise.all([jobRepository.claimNextJobs(3), jobRepository.claimNextJobs(3)]);

        const allClaimedIds = [...batch1.map((j) => j.id), ...batch2.map((j) => j.id)];
        const uniqueIds = new Set(allClaimedIds);
        expect(uniqueIds.size).toBe(allClaimedIds.length);
        expect(allClaimedIds.length).toBe(6);
    });
});
