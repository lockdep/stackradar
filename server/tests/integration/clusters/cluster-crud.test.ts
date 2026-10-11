import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema/index.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import { edition } from "../../../src/edition.js";

// Cloud-only: creates clusters through the API, which the community edition refuses beyond its bootstrap cluster; `STACKRADAR_EDITION=community pnpm test` skips it.
const describeCloud = describe.skipIf(!edition.isCloud);

describeCloud("Cluster CRUD", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;

    function authHeaders() {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await createOrgWithOwner(getTestDb());
    });

    // -------------------------------------------------------------------------
    // GET /api/clusters
    // -------------------------------------------------------------------------

    describe("GET /api/clusters", () => {
        it("should return empty list when no clusters exist", async () => {
            const res = await request(app).get("/api/clusters").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters).toEqual([]);
        });

        it("should list clusters for the org", async () => {
            await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            await createCluster(getTestDb(), testData.org.id, { name: "staging" });

            const res = await request(app).get("/api/clusters").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters).toHaveLength(2);
        });

        it("should flag clusters that have an active API key", async () => {
            const db = getTestDb();
            const withKey = await createCluster(db, testData.org.id, { name: "prod" });
            const withoutKey = await createCluster(db, testData.org.id, { name: "staging" });
            await createClusterApiKey(db, withKey.id, testData.org.id, testData.user.id);

            const res = await request(app).get("/api/clusters").set(authHeaders());
            expect(res.status).toBe(200);
            const byName: Record<string, { hasApiKey: boolean }> = Object.fromEntries(
                (res.body.clusters as { name: string; hasApiKey: boolean }[]).map((c) => [c.name, c]),
            );
            expect(byName[withKey.name]!.hasApiKey).toBe(true);
            expect(byName[withoutKey.name]!.hasApiKey).toBe(false);
        });

        it("should flag hasApiKey=false after the cluster's key is revoked", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            await request(app).delete(`/api/clusters/${cluster.id}/api-key`).set(authHeaders());

            const res = await request(app).get("/api/clusters").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters[0].hasApiKey).toBe(false);
        });

        it("should not return clusters from other orgs", async () => {
            const db = getTestDb();
            const other = await createOrgWithOwner(db, { email: "other@test.com" }, { slug: "other-org" });
            await createCluster(db, other.org.id, { name: "other-cluster" });

            const res = await request(app).get("/api/clusters").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters).toHaveLength(0);
        });

        it("should require auth", async () => {
            const res = await request(app).get("/api/clusters");
            expect(res.status).toBe(401);
        });
    });

    // -------------------------------------------------------------------------
    // POST /api/clusters
    // -------------------------------------------------------------------------

    describe("GET /api/clusters/names", () => {
        it("should list only id and name, for the org's clusters only", async () => {
            const db = getTestDb();
            await createCluster(db, testData.org.id, { name: "prod" });
            await createCluster(db, testData.org.id, { name: "staging" });
            const other = await createOrgWithOwner(db, { email: "other@test.com" }, { slug: "other-org" });
            await createCluster(db, other.org.id, { name: "theirs" });

            const res = await request(app).get("/api/clusters/names").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters.map((c: { name: string }) => c.name).sort()).toEqual(["prod", "staging"]);
            for (const c of res.body.clusters) expect(Object.keys(c).sort()).toEqual(["id", "name"]);
        });

        it("is not shadowed by the :id route", async () => {
            const res = await request(app).get("/api/clusters/names").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters).toEqual([]);
        });
    });

    describe("POST /api/clusters", () => {
        it("should create a cluster", async () => {
            const res = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "production", description: "Prod cluster" });

            expect(res.status).toBe(201);
            expect(res.body.cluster.name).toBe("production");
            expect(res.body.cluster.description).toBe("Prod cluster");
            expect(res.body.cluster.orgId).toBe(testData.org.id);
            expect(res.body.cluster.id).toBeDefined();
            // Created with its scanner key, not waiting for a second request.
            expect(res.body.cluster.hasApiKey).toBe(true);
        });

        it("stores a free-text name exactly as sent", async () => {
            const name = "Produksjon Øst 東京";
            const res = await request(app).post("/api/clusters").set(authHeaders()).send({ name });

            expect(res.status).toBe(201);
            const [row] = await getTestDb()
                .select()
                .from(schema.clusters)
                .where(eq(schema.clusters.id, res.body.cluster.id));
            expect(row!.name).toBe(name);
        });

        it("should return a working scanner API key with the new cluster", async () => {
            const res = await request(app).post("/api/clusters").set(authHeaders()).send({ name: "production" });

            expect(res.status).toBe(201);
            expect(res.body.apiKey).toMatch(/^[A-Za-z0-9_-]{32}$/);

            // Exactly one active key, scoped to this cluster and no wider.
            const keys = await getTestDb()
                .select()
                .from(schema.apiKeys)
                .where(eq(schema.apiKeys.clusterId, res.body.cluster.id));

            expect(keys).toHaveLength(1);
            expect(keys[0]!.isActive).toBe(true);
            expect(keys[0]!.orgId).toBe(testData.org.id);
            expect(keys[0]!.createdBy).toBe(testData.user.id);
            expect(keys[0]!.scopes).toEqual(["sbom:write"]);

            // The plaintext is returned once and stored only as a hash.
            expect(keys[0]!.keyHash).not.toBe(res.body.apiKey);
        });

        it("should not leave a cluster behind when creation fails", async () => {
            const db = getTestDb();
            const proOrg = await createOrgWithOwner(db, { email: "pro2@test.com" }, { slug: "pro-org-2", plan: "pro" });
            await createCluster(db, proOrg.org.id, { name: "prod" });

            await request(app)
                .post("/api/clusters")
                .set(
                    createInternalHeaders({
                        id: proOrg.user.id,
                        email: proOrg.user.email,
                        orgId: proOrg.org.id,
                        orgName: proOrg.org.name,
                        orgSlug: proOrg.org.slug,
                        orgPlan: "pro",
                    }),
                )
                .send({ name: "prod" });

            const clusters = await db.select().from(schema.clusters).where(eq(schema.clusters.orgId, proOrg.org.id));
            expect(clusters).toHaveLength(1);
        });

        it("should reject missing name", async () => {
            const res = await request(app).post("/api/clusters").set(authHeaders()).send({ description: "No name" });

            expect(res.status).toBe(400);
        });

        it("should reject duplicate cluster name within org", async () => {
            // Use a pro-plan org so the plan limit doesn't fire before the unique constraint.
            const db = getTestDb();
            const proOrg = await createOrgWithOwner(db, { email: "pro@test.com" }, { slug: "pro-org", plan: "pro" });
            await createCluster(db, proOrg.org.id, { name: "prod" });

            const res = await request(app)
                .post("/api/clusters")
                .set(
                    createInternalHeaders({
                        id: proOrg.user.id,
                        email: proOrg.user.email,
                        orgId: proOrg.org.id,
                        orgName: proOrg.org.name,
                        orgSlug: proOrg.org.slug,
                        orgPlan: "pro",
                    }),
                )
                .send({ name: "prod" });

            expect(res.status).toBe(409); // unique violation surfaced as a conflict the user can fix
        });

        it("should require auth", async () => {
            const res = await request(app).post("/api/clusters").send({ name: "x" });
            expect(res.status).toBe(401);
        });
    });

    // -------------------------------------------------------------------------
    // GET /api/clusters/:id
    // -------------------------------------------------------------------------

    describe("GET /api/clusters/:id", () => {
        it("should return a cluster by id", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });

            const res = await request(app).get(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.cluster.id).toBe(cluster.id);
            expect(res.body.cluster.name).toBe("prod");
            expect(res.body.cluster.hasApiKey).toBe(false);
        });

        it("should report hasApiKey=true when the cluster has an active key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app).get(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.cluster.hasApiKey).toBe(true);
        });

        it("should return 404 for unknown id", async () => {
            const res = await request(app).get("/api/clusters/00000000-0000-0000-0000-000000000000").set(authHeaders());
            expect(res.status).toBe(404);
        });

        it("should return 404 for cluster belonging to another org", async () => {
            const db = getTestDb();
            const other = await createOrgWithOwner(db, { email: "other@test.com" }, { slug: "other-org" });
            const cluster = await createCluster(db, other.org.id, { name: "other-cluster" });

            const res = await request(app).get(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // PATCH /api/clusters/:id
    // -------------------------------------------------------------------------

    describe("PATCH /api/clusters/:id", () => {
        it("should update cluster name and description", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "old-name" });

            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(authHeaders())
                .send({ name: "new-name", description: "updated" });

            expect(res.status).toBe(200);
            expect(res.body.cluster.name).toBe("new-name");
            expect(res.body.cluster.description).toBe("updated");
            expect(res.body.cluster.hasApiKey).toBe(false);
        });

        it("round-trips a free-text name with spaces and non-ASCII letters through JSON and Postgres", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "old-name" });
            const name = "Produksjon Øst 東京 v1.2_beta";

            const res = await request(app).patch(`/api/clusters/${cluster.id}`).set(authHeaders()).send({ name });

            expect(res.status).toBe(200);
            expect(res.body.cluster.name).toBe(name);

            // What the database holds, not what the response echoed.
            const [row] = await db.select().from(schema.clusters).where(eq(schema.clusters.id, cluster.id));
            expect(row!.name).toBe(name);
            expect(Buffer.from(row!.name, "utf8").equals(Buffer.from(name, "utf8"))).toBe(true);
        });

        it("trims surrounding whitespace from the name", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "old-name" });

            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(authHeaders())
                .send({ name: "  Production EU  " });

            expect(res.status).toBe(200);
            expect(res.body.cluster.name).toBe("Production EU");
        });

        it("rejects a name with special characters", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "old-name" });

            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(authHeaders())
                .send({ name: "prod/eu" });

            expect(res.status).toBe(400);
        });

        it("returns 409 when renaming to a name another cluster in the org already has", async () => {
            const db = getTestDb();
            await createCluster(db, testData.org.id, { name: "Production EU" });
            const cluster = await createCluster(db, testData.org.id, { name: "old-name" });

            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(authHeaders())
                .send({ name: "Production EU" });

            expect(res.status).toBe(409);
            expect(res.body.error).toMatch(/already exists/);
        });

        it("should preserve hasApiKey=true across an update", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "old-name" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(authHeaders())
                .send({ name: "new-name" });

            expect(res.status).toBe(200);
            expect(res.body.cluster.hasApiKey).toBe(true);
        });

        it("should return 404 for unknown cluster", async () => {
            const res = await request(app)
                .patch("/api/clusters/00000000-0000-0000-0000-000000000000")
                .set(authHeaders())
                .send({ name: "new-name" });
            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // DELETE /api/clusters/:id
    // -------------------------------------------------------------------------

    describe("DELETE /api/clusters/:id", () => {
        it("should delete a cluster", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "to-delete" });

            const res = await request(app).delete(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(res.status).toBe(200);

            // Confirm it's gone
            const check = await request(app).get(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(check.status).toBe(404);
        });

        it("should return 404 for unknown cluster", async () => {
            const res = await request(app)
                .delete("/api/clusters/00000000-0000-0000-0000-000000000000")
                .set(authHeaders());
            expect(res.status).toBe(404);
        });

        it("should revoke the cluster's API keys", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "to-delete" });
            const { apiKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app).delete(`/api/clusters/${cluster.id}`).set(authHeaders());
            expect(res.status).toBe(200);

            // `api_keys.cluster_id` is ON DELETE SET NULL, so without an explicit
            // revoke the row survives as an active *org-scoped* key carrying
            // sbom:write — a credential the user believes they destroyed.
            const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
            expect(row?.isActive).toBe(false);
            expect(row?.revokedAt).not.toBeNull();
        });

        it("should not let another org's delete revoke keys", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            const { apiKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const outsider = await createOrgWithOwner(db);
            const res = await request(app)
                .delete(`/api/clusters/${cluster.id}`)
                .set(
                    createInternalHeaders({
                        id: outsider.user.id,
                        email: outsider.user.email,
                        orgId: outsider.org.id,
                        orgName: outsider.org.name,
                        orgSlug: outsider.org.slug,
                    }),
                );
            expect(res.status).toBe(404);

            const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
            expect(row?.isActive).toBe(true);
        });
    });
});
