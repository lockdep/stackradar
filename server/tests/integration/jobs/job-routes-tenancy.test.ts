import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    createOrgWithOwner,
    type SeedTestScenarioResult,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { Job, NewJob } from "../../../src/db/schema/jobs.js";

/**
 * Tenancy on the jobs routes. Jobs are addressed by bare UUID, so the org
 * check on `/:id` reads is the only thing keeping one org's jobs invisible
 * to another — and it must hold even when the caller has no active org
 * (`requireOrg` refuses that outright rather than letting an empty orgId
 * skip the comparison).
 */
describe("job routes tenancy", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;
    let otherOrg: CreateOrgWithOwnerResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
        otherOrg = await createOrgWithOwner(
            db,
            { email: "other-owner@example.com" },
            { name: "Other Org", slug: "other-org" },
        );
    });

    function insertJob(overrides: Partial<NewJob> = {}): Promise<Job> {
        const db = getTestDb();
        return db
            .insert(schema.jobs)
            .values({
                orgId: testData.org.id,
                type: "vulnerability_scan",
                title: "Test Job",
                triggeredBy: "manual",
                status: "pending",
                ...overrides,
            })
            .returning()
            .then((rows) => rows[0]!);
    }

    function ownerHeaders() {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
        });
    }

    function otherOrgHeaders() {
        return createInternalHeaders({
            id: otherOrg.user.id,
            email: otherOrg.user.email,
            orgId: otherOrg.org.id,
        });
    }

    /** Internal auth with no org context at all — orgId is "" server-side. */
    function orglessHeaders() {
        return createInternalHeaders({
            id: otherOrg.user.id,
            email: otherOrg.user.email,
        });
    }

    it("owner org can read its own job by id", async () => {
        const job = await insertJob();
        const response = await request(app).get(`/api/jobs/${job.id}`).set(ownerHeaders());
        expect(response.status).toBe(200);
        expect(response.body.id).toBe(job.id);
    });

    it("another org gets 404 for a job it does not own", async () => {
        const job = await insertJob();
        const response = await request(app).get(`/api/jobs/${job.id}`).set(otherOrgHeaders());
        expect(response.status).toBe(404);
    });

    it("a caller with no org context is refused with 403, not given cross-org access", async () => {
        const job = await insertJob();
        for (const [method, path] of [
            ["get", `/api/jobs/${job.id}`],
            ["get", "/api/jobs"],
        ] as const) {
            const response = await request(app)[method](path).set(orglessHeaders());
            expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
        }
    });
});
