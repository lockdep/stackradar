/**
 * The admin page's database-backed actions over HTTP: retrying a job,
 * retrying every job that is out of retries, collecting orphaned images,
 * and queueing a fleet rescan. Each runs the existing path — the job table
 * reset the worker would respect, the nightly sweep, the mirror sync's
 * enqueue — so the assertions are about the rows afterwards, not about the
 * endpoint's own bookkeeping. The feed triggers are unit-tested with fake
 * runners (`tests/unit/services/admin-actions.test.ts`); here only their
 * refusal under the test process's topology is checked.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { createInternalHeaders, getTestApp } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createImage,
    createSbom,
    seedRunningImage,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { JobStatus } from "../../../src/db/schema/jobs.js";
import { topology } from "../../../src/topology.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

describe("admin actions", () => {
    let app: Express;
    let t: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        t = await seedTestScenario(getTestDb());
    });

    const admin = () =>
        createInternalHeaders({
            id: t.user.id,
            email: t.user.email,
            orgId: t.org.id,
            orgName: t.org.name,
            orgSlug: t.org.slug,
            orgPlan: t.org.plan,
            isAdmin: true,
        });

    async function insertJob(values: { status: JobStatus; retryCount?: number; maxRetries?: number }) {
        const [job] = await getTestDb()
            .insert(schema.jobs)
            .values({
                orgId: t.org.id,
                type: "vulnerability_scan",
                title: `${values.status} job`,
                triggeredBy: "manual",
                status: values.status,
                retryCount: values.retryCount ?? 0,
                maxRetries: values.maxRetries ?? 3,
                errorCode: values.status === "failed" ? "BOOM" : null,
                errorMessage: values.status === "failed" ? "it broke" : null,
                startedAt: values.status === "failed" ? new Date() : null,
                completedAt: values.status === "failed" ? new Date() : null,
            })
            .returning();
        return job!;
    }

    it("is platform-admin only", async () => {
        const headers = createInternalHeaders({ id: t.user.id, email: t.user.email, orgId: t.org.id });
        for (const path of ["/api/admin/rescan", "/api/admin/images/gc", "/api/admin/jobs/retry-stuck"]) {
            expect((await request(app).post(path).set(headers)).status, path).toBe(403);
        }
    });

    describe("POST /api/admin/jobs/:id/retry", () => {
        it("puts a failed job back in the queue with its budget restored and its error cleared", async () => {
            const job = await insertJob({ status: "failed", retryCount: 3 });

            const res = await request(app).post(`/api/admin/jobs/${job.id}/retry`).set(admin());

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id: job.id, status: "pending", retryCount: 0, errorMessage: null });
            const [row] = await getTestDb().select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
            expect(row).toMatchObject({ status: "pending", retryCount: 0, errorCode: null, startedAt: null });
        });

        it("refuses anything but a failed job, and 404s an unknown one", async () => {
            const done = await insertJob({ status: "completed" });
            expect((await request(app).post(`/api/admin/jobs/${done.id}/retry`).set(admin())).status).toBe(409);
            expect(
                (await request(app).post("/api/admin/jobs/00000000-0000-4000-8000-000000000000/retry").set(admin()))
                    .status,
            ).toBe(404);
            expect((await request(app).post("/api/admin/jobs/not-a-uuid/retry").set(admin())).status).toBe(400);
        });
    });

    describe("POST /api/admin/jobs/retry-stuck", () => {
        it("retries exactly the failed jobs with no retries left", async () => {
            const stuck = await insertJob({ status: "failed", retryCount: 3, maxRetries: 3 });
            const stillHasBudget = await insertJob({ status: "failed", retryCount: 1, maxRetries: 3 });
            const done = await insertJob({ status: "completed", retryCount: 3 });

            const res = await request(app).post("/api/admin/jobs/retry-stuck").set(admin());

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ retried: 1 });
            const byId = new Map((await getTestDb().select().from(schema.jobs)).map((j) => [j.id, j.status] as const));
            expect(byId.get(stuck.id)).toBe("pending");
            expect(byId.get(stillHasBudget.id)).toBe("failed");
            expect(byId.get(done.id)).toBe("completed");
        });

        it("lists the same set under ?stuck=1 on the jobs table", async () => {
            const stuck = await insertJob({ status: "failed", retryCount: 3, maxRetries: 3 });
            await insertJob({ status: "failed", retryCount: 1, maxRetries: 3 });

            const res = await request(app).get("/api/admin/jobs?stuck=1").set(admin());

            expect(res.status).toBe(200);
            expect(res.body.total).toBe(1);
            expect(res.body.jobs[0].id).toBe(stuck.id);
        });
    });

    describe("POST /api/admin/images/gc", () => {
        it("runs the nightly sweep now and reports what it collected", async () => {
            const db = getTestDb();
            // Orphaned (nothing references it) and old enough for every plan window.
            await createImage(db, t.org.id, t.cluster.id, {
                repository: "acme/stale",
                lastSeenAt: new Date(Date.now() - 800 * DAY_MS),
            });
            // Referenced: never collected, whatever its age.
            await seedRunningImage(db, t.org.id, t.cluster.id, { workloadName: "web" });

            const res = await request(app).post("/api/admin/images/gc").set(admin());

            expect(res.status).toBe(200);
            expect(res.body.collected).toBe(1);
            expect(res.body.limit).toBeGreaterThan(0);
            expect((await db.select().from(schema.images)).length).toBe(1);
        });
    });

    describe("POST /api/admin/rescan", () => {
        it("queues one scheduled scan per image with an SBOM, skipping those with a scan open", async () => {
            const db = getTestDb();
            const scanned = await createImage(db, t.org.id, t.cluster.id, { repository: "acme/a" });
            await createSbom(db, { imageId: scanned.id });
            const busy = await createImage(db, t.org.id, t.cluster.id, { repository: "acme/b" });
            await createSbom(db, { imageId: busy.id });
            await db.insert(schema.jobs).values({
                orgId: t.org.id,
                imageId: busy.id,
                type: "vulnerability_scan",
                title: "already queued",
                triggeredBy: "sbom_upload",
                status: "pending",
            });
            await createImage(db, t.org.id, t.cluster.id, { repository: "acme/unscanned" });

            const res = await request(app).post("/api/admin/rescan").set(admin());

            expect(res.status).toBe(202);
            expect(res.body).toEqual({ enqueued: 1 });
            const queued = await db
                .select({ imageId: schema.jobs.imageId, triggeredBy: schema.jobs.triggeredBy })
                .from(schema.jobs)
                .where(eq(schema.jobs.type, "scheduled_scan"));
            expect(queued).toEqual([{ imageId: scanned.id, triggeredBy: "manual" }]);
        });
    });

    describe("feed triggers", () => {
        it.skipIf(topology !== "split")("refuse in the split topology and name the CronJob", async () => {
            for (const [path, cronJob] of [
                ["/api/admin/osv/sync", "osv-sync"],
                ["/api/admin/osv/bootstrap", "osv-bootstrap"],
                ["/api/admin/feeds/epss/sync", "epss-sync"],
                ["/api/admin/feeds/kev/sync", "kev-sync"],
                ["/api/admin/feeds/artifacthub/sync", "artifacthub-sync"],
            ] as const) {
                const res = await request(app).post(path).set(admin());
                expect(res.status, path).toBe(409);
                expect(res.body.error, path).toContain(`${cronJob} CronJob`);
            }
        });

        it("400s an unknown feed", async () => {
            expect((await request(app).post("/api/admin/feeds/nvd/sync").set(admin())).status).toBe(400);
        });
    });
});
