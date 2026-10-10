/**
 * `jobService.processReadyJobs` claims one job at a time. The regression it
 * guards: on 2026-09-10 the worker claimed a batch of ten as `processing`,
 * was OOM-killed on the second, and the eight it had never started stayed
 * `processing` for good — too young for the startup stale sweep, and
 * counted as "open" by the nightly platform-scan sweep ever after.
 */

import { describe, it, expect, beforeEach, beforeAll, afterEach, vi } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import type { Job, NewJob } from "../../../src/db/schema/jobs.js";
import * as schema from "../../../src/db/schema/index.js";
import { eq } from "drizzle-orm";
import type { jobService as JobServiceType } from "../../../src/services/job.service.js";

describe("jobService.processReadyJobs", () => {
    let testData: SeedTestScenarioResult;
    let jobService: typeof JobServiceType;

    beforeAll(async () => {
        const mod = await import("../../../src/services/job.service.js");
        jobService = mod.jobService;
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    async function insertJob(overrides: Partial<NewJob> = {}): Promise<Job> {
        const [job] = await getTestDb()
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

    async function statusOf(id: string): Promise<string> {
        const [row] = await getTestDb()
            .select({ status: schema.jobs.status })
            .from(schema.jobs)
            .where(eq(schema.jobs.id, id));
        return row!.status;
    }

    it("claims each job only as it starts, so a crash mid-batch strands nothing it had not begun", async () => {
        const first = await insertJob({ title: "first", priority: 3 });
        const second = await insertJob({ title: "second", priority: 2 });
        const third = await insertJob({ title: "third", priority: 1 });

        const seen: string[] = [];
        vi.spyOn(jobService, "executeJob").mockImplementation(async (job: Job) => {
            seen.push(job.id);
            // The worker process dying is not an error the job loop can catch;
            // a rejection that escapes executeJob is the closest stand-in.
            if (job.id === second.id) throw new Error("simulated worker death");
        });

        await expect(jobService.processReadyJobs(10)).rejects.toThrow("simulated worker death");

        expect(seen).toEqual([first.id, second.id]);
        expect(await statusOf(first.id)).toBe("processing");
        expect(await statusOf(second.id)).toBe("processing");
        // Never claimed: still there for the next poll or the next worker.
        expect(await statusOf(third.id)).toBe("pending");
    });

    it("stops at the batch limit and reports how many it ran", async () => {
        for (let i = 0; i < 4; i += 1) await insertJob({ title: `job ${i}` });
        vi.spyOn(jobService, "executeJob").mockResolvedValue(undefined);

        expect(await jobService.processReadyJobs(3)).toBe(3);
        expect(await jobService.processReadyJobs(3)).toBe(1);
        expect(await jobService.processReadyJobs(3)).toBe(0);
    });
});
