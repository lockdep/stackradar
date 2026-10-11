/**
 * The Overview tab's job-queue figures.
 *
 * `byStatus` counts every job ever created, so `completed` climbs forever and
 * sets the scale for everything beside it — a queue with one job wedged for
 * three hours renders identically to a healthy one. These three replace it, and
 * each one is only useful if it is scoped exactly right:
 *
 * - the oldest-pending age must ignore `scheduled` jobs, or every nightly scan
 *   waiting for its time reads as a stuck worker;
 * - the 24h window must key on `completed_at` and exclude cancellations, or a
 *   burst of user cancellations dilutes a real failure rate;
 * - the out-of-retries count must key on the job's own budget
 *   (`retry_count >= max_retries`), or it is a number nobody can act on.
 *
 * Each of those scopings is a test below, because each is a way the figure could
 * be silently wrong while still rendering a plausible number.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { JobStatus } from "../../../src/db/schema/jobs.js";

let adminStatusRepository: typeof import("../../../src/repositories/admin-status.repository.js").adminStatusRepository;
let testData: SeedTestScenarioResult;

beforeAll(async () => {
    adminStatusRepository = (await import("../../../src/repositories/admin-status.repository.js"))
        .adminStatusRepository;
});

beforeEach(async () => {
    await cleanAllData();
    testData = await seedTestScenario(getTestDb());
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function ago(ms: number): Date {
    return new Date(Date.now() - ms);
}

async function insertJob(values: {
    status: JobStatus;
    createdAt?: Date;
    completedAt?: Date;
    retryCount?: number;
    maxRetries?: number;
}) {
    await getTestDb()
        .insert(schema.jobs)
        .values({
            orgId: testData.org.id,
            type: "vulnerability_scan",
            title: `${values.status} job`,
            triggeredBy: "manual",
            ...values,
        });
}

async function health() {
    return (await adminStatusRepository.getSystemStats()).jobs.health;
}

describe("queue health — oldest pending job", () => {
    it("is null when nothing is pending", async () => {
        await insertJob({ status: "completed", completedAt: new Date() });

        // Null, not 0. Zero would render as "a job just arrived", which is a
        // different and much less reassuring claim than "the queue is empty".
        expect((await health()).oldestPendingAgeSeconds).toBeNull();
    });

    it("measures the oldest pending job, not the newest", async () => {
        await insertJob({ status: "pending", createdAt: ago(2 * HOUR) });
        await insertJob({ status: "pending", createdAt: ago(1 * MINUTE) });

        const age = (await health()).oldestPendingAgeSeconds;

        expect(age).not.toBeNull();
        // Two hours, with a generous window — the age is computed from the
        // database clock, which is not the clock this assertion was written on.
        expect(age!).toBeGreaterThan(2 * 3600 - 60);
        expect(age!).toBeLessThan(2 * 3600 + 60);
    });

    it("ignores scheduled jobs waiting for their time", async () => {
        // A scheduled job is doing exactly what it was asked to. Counting it
        // would make every nightly scan look like a wedged worker.
        await insertJob({ status: "scheduled", createdAt: ago(12 * HOUR) });
        await insertJob({ status: "processing", createdAt: ago(6 * HOUR) });

        expect((await health()).oldestPendingAgeSeconds).toBeNull();
    });
});

describe("queue health — 24h failure window", () => {
    it("counts terminal outcomes that completed inside the window", async () => {
        await insertJob({ status: "completed", completedAt: ago(1 * HOUR) });
        await insertJob({ status: "completed", completedAt: ago(20 * HOUR) });
        await insertJob({ status: "failed", completedAt: ago(2 * HOUR) });

        expect((await health()).last24h).toEqual({ completed: 2, failed: 1 });
    });

    it("excludes anything that completed before the window", async () => {
        await insertJob({ status: "failed", completedAt: ago(25 * HOUR) });
        await insertJob({ status: "completed", completedAt: ago(3 * 24 * HOUR) });

        expect((await health()).last24h).toEqual({ completed: 0, failed: 0 });
    });

    it("keys on completion, not creation", async () => {
        // Created three days ago, finished an hour ago — a long-running job is
        // still a fresh outcome, and keying on created_at would drop it.
        await insertJob({ status: "completed", createdAt: ago(3 * 24 * HOUR), completedAt: ago(1 * HOUR) });

        expect((await health()).last24h).toEqual({ completed: 1, failed: 0 });
    });

    it("excludes cancellations from the window entirely", async () => {
        await insertJob({ status: "completed", completedAt: ago(1 * HOUR) });
        await insertJob({ status: "cancelled", completedAt: ago(1 * HOUR) });

        // A cancellation is a person's decision, not a worker outcome. In the
        // denominator it would let a burst of them dilute a real failure rate.
        expect((await health()).last24h).toEqual({ completed: 1, failed: 0 });
    });
});

describe("queue health — jobs out of retries", () => {
    it("counts failed jobs that have spent every retry", async () => {
        await insertJob({ status: "failed", retryCount: 3, maxRetries: 3 });
        await insertJob({ status: "failed", retryCount: 5, maxRetries: 3 });

        expect((await health()).stuckAtMaxRetries).toBe(2);
    });

    it("excludes failed jobs that still have a retry left", async () => {
        // Budget left, so nothing here needs a person.
        await insertJob({ status: "failed", retryCount: 1, maxRetries: 3 });

        expect((await health()).stuckAtMaxRetries).toBe(0);
    });

    it("excludes non-failed jobs regardless of their retry count", async () => {
        // A job that exhausted its retries and then succeeded is not stuck; the
        // retry count alone cannot tell the two apart.
        await insertJob({ status: "completed", retryCount: 3, maxRetries: 3, completedAt: new Date() });
        await insertJob({ status: "cancelled", retryCount: 3, maxRetries: 3 });

        expect((await health()).stuckAtMaxRetries).toBe(0);
    });
});

describe("queue health on an empty queue", () => {
    it("reads as healthy rather than as missing data", async () => {
        expect(await health()).toEqual({
            oldestPendingAgeSeconds: null,
            last24h: { completed: 0, failed: 0 },
            stuckAtMaxRetries: 0,
        });
    });
});
