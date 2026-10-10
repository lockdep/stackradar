import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";

import { edition } from "../../../src/edition.js";
// Cloud-only: this surface is unmounted in the community edition (`STACKRADAR_EDITION=community pnpm test` skips it).
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Cluster plan limits", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    function authHeaders(orgId = testData.org.id) {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
            orgPlan: testData.org.plan,
        });
    }

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await createOrgWithOwner(getTestDb(), {}, { plan: "free" });
    });

    describe("free plan (limit: 1 cluster)", () => {
        it("should allow creating the first cluster", async () => {
            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "my-cluster" });

            expect(res.status).toBe(201);
        });

        it("should reject a second cluster with 403", async () => {
            await createCluster(getTestDb(), testData.org.id, { name: "existing" });

            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "second-cluster" });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/maximum of 1 cluster/i);
            expect(res.body.code).toBe("PLAN_LIMIT_EXCEEDED");
        });

        it("should allow only one of several concurrent creates", async () => {
            // The limit is checked inside the create transaction under a
            // SELECT FOR UPDATE on the org row; without that lock, concurrent
            // requests all pass the count and the org ends up over the cap.
            const results = await Promise.all(
                Array.from({ length: 5 }, (_, i) =>
                    request(app)
                        .post("/api/clusters")
                        .set(authHeaders())
                        .send({ name: `racer-${i}` }),
                ),
            );

            expect(results.filter((r) => r.status === 201)).toHaveLength(1);
            expect(results.filter((r) => r.status === 403)).toHaveLength(4);
        });

        it("should allow creating a cluster after the only cluster is deleted", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "existing" });
            await request(app).delete(`/api/clusters/${cluster.id}`).set(authHeaders());

            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "replacement" });

            expect(res.status).toBe(201);
        });
    });

    describe("pro plan (limit: 5 clusters)", () => {
        beforeEach(async () => {
            await cleanAllData();
            testData = await createOrgWithOwner(getTestDb(), {}, { plan: "pro" });
        });

        it("should allow creating up to 5 clusters", async () => {
            const db = getTestDb();
            for (let i = 0; i < 4; i++) {
                await createCluster(db, testData.org.id, { name: `cluster-${i}` });
            }

            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "cluster-5" });

            expect(res.status).toBe(201);
        });

        it("should reject the 6th cluster with 403", async () => {
            const db = getTestDb();
            for (let i = 0; i < 5; i++) {
                await createCluster(db, testData.org.id, { name: `cluster-${i}` });
            }

            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "cluster-6" });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/maximum of 5 cluster/i);
            expect(res.body.code).toBe("PLAN_LIMIT_EXCEEDED");
        });
    });

});
