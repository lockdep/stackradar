/**
 * `getAdminJobs().total` is the client's page count, not a decoration:
 * `JobsTab` divides it by the page size to decide how many pages exist and
 * whether Next is enabled. An unfiltered count under a status filter therefore
 * paginates into rows that cannot exist — three failures out of thousands of
 * jobs rendered as "Page 1 of N" with a Next button leading to nothing.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { JobStatus } from "../../../src/db/schema/jobs.js";

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;
let testData: SeedTestScenarioResult;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
});

beforeEach(async () => {
    await cleanAllData();
    testData = await seedTestScenario(getTestDb());
});

/** `n` jobs in `status`, all in the seeded org. */
async function insertJobs(status: JobStatus, n: number) {
    await getTestDb()
        .insert(schema.jobs)
        .values(
            Array.from({ length: n }, (_, i) => ({
                orgId: testData.org.id,
                type: "vulnerability_scan" as const,
                title: `${status} job ${i}`,
                triggeredBy: "manual" as const,
                status,
            })),
        );
}

describe("adminRepository.getAdminJobs", () => {
    it("counts only the rows the status filter can return", async () => {
        await insertJobs("completed", 7);
        await insertJobs("failed", 3);

        const result = await adminRepository.getAdminJobs({ status: ["failed"], limit: 50, offset: 0 });

        expect(result.jobs).toHaveLength(3);
        // The bug: 10 here meant the UI offered a second page of failures.
        expect(result.total).toBe(3);
    });

    it("counts across every status in a multi-status filter", async () => {
        await insertJobs("completed", 7);
        await insertJobs("failed", 3);
        await insertJobs("pending", 2);

        const result = await adminRepository.getAdminJobs({ status: ["failed", "pending"] });

        expect(result.total).toBe(5);
    });

    it("counts every job when no filter is given", async () => {
        await insertJobs("completed", 7);
        await insertJobs("failed", 3);

        const result = await adminRepository.getAdminJobs({});

        expect(result.total).toBe(10);
    });

    it("keeps the total independent of the page window", async () => {
        await insertJobs("failed", 5);

        const page = await adminRepository.getAdminJobs({ status: ["failed"], limit: 2, offset: 2 });

        expect(page.jobs).toHaveLength(2);
        // The total describes the filtered set, not the slice of it returned.
        expect(page.total).toBe(5);
    });

    it("reports zero for a status with no jobs", async () => {
        await insertJobs("completed", 4);

        const result = await adminRepository.getAdminJobs({ status: ["failed"] });

        expect(result.jobs).toEqual([]);
        expect(result.total).toBe(0);
    });
});
