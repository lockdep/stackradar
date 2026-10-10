import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders, createApiKeyHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createCluster,
    createClusterApiKey,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";

describe("Cluster API key management", () => {
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
    // POST /api/clusters/:id/api-key  (rotate)
    // -------------------------------------------------------------------------

    describe("POST /api/clusters/:id/api-key", () => {
        it("should generate a cluster API key", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id);

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key`)
                .set(authHeaders());

            expect(res.status).toBe(201);
            expect(res.body.apiKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
        });

        it("should revoke previous key when rotating", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            const { rawKey: oldKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            // Rotate
            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key`)
                .set(authHeaders());
            expect(res.status).toBe(201);

            // Old key should no longer authenticate
            const check = await request(app)
                .get(`/api/clusters`)
                .set(createApiKeyHeaders(oldKey));
            expect(check.status).toBe(401);
        });

        it("should return 404 for unknown cluster", async () => {
            const res = await request(app)
                .post("/api/clusters/00000000-0000-0000-0000-000000000000/api-key")
                .set(authHeaders());
            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // GET /api/clusters/:id/api-key
    // -------------------------------------------------------------------------

    describe("GET /api/clusters/:id/api-key", () => {
        it("should return masked API key info", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .get(`/api/clusters/${cluster.id}/api-key`)
                .set(authHeaders());

            expect(res.status).toBe(200);
            expect(res.body.apiKey).toMatch(/^[A-Za-z0-9_-]{8}•+$/);
            expect(res.body.createdAt).toBeDefined();
        });

        it("should return 404 when no active key exists", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id);

            const res = await request(app)
                .get(`/api/clusters/${cluster.id}/api-key`)
                .set(authHeaders());

            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // GET /api/clusters/api-keys
    // -------------------------------------------------------------------------

    describe("GET /api/clusters/api-keys", () => {
        it("should list every cluster with masked key metadata, keyless ones included", async () => {
            const db = getTestDb();
            const withKey = await createCluster(db, testData.org.id, { name: "a-with-key" });
            const { rawKey } = await createClusterApiKey(db, withKey.id, testData.org.id, testData.user.id);
            const legacy = await createCluster(db, testData.org.id, { name: "b-legacy" });
            await createClusterApiKey(db, legacy.id, testData.org.id, testData.user.id, { revealable: false });
            const without = await createCluster(db, testData.org.id, { name: "c-without" });
            // Another org's cluster never shows up.
            const other = await createOrgWithOwner(db);
            await createCluster(db, other.org.id, { name: "other" });

            const res = await request(app).get("/api/clusters/api-keys").set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.clusters.map((c: { id: string }) => c.id)).toEqual([withKey.id, legacy.id, without.id]);

            const [a, b, c] = res.body.clusters;
            expect(a.key.apiKey).toMatch(/^[A-Za-z0-9_-]{8}•+$/);
            expect(a.key.apiKey.startsWith(rawKey.slice(0, 8))).toBe(true);
            expect(a.key.revealable).toBe(true);
            expect(a.key.lastRevealedAt).toBeNull();
            expect(b.key.revealable).toBe(false);
            expect(c.key).toBeNull();
            expect(JSON.stringify(res.body)).not.toContain(rawKey);
        });
    });

    // -------------------------------------------------------------------------
    // POST /api/clusters/:id/api-key/reveal
    // -------------------------------------------------------------------------

    describe("POST /api/clusters/:id/api-key/reveal", () => {
        it("should return the plaintext of a seeded key and stamp the reveal", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            const { rawKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const before = await request(app).get(`/api/clusters/${cluster.id}/api-key`).set(authHeaders());
            expect(before.body.revealable).toBe(true);
            expect(before.body.lastRevealedAt).toBeNull();

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(authHeaders());

            expect(res.status).toBe(200);
            expect(res.body.apiKey).toBe(rawKey);

            const after = await request(app).get(`/api/clusters/${cluster.id}/api-key`).set(authHeaders());
            expect(after.body.lastRevealedAt).not.toBeNull();
            // The masked GET still masks: revealing is a separate, audited act.
            expect(after.body.apiKey).not.toBe(rawKey);
        });

        it("should reveal the key a rotation just minted", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id);
            const rotated = await request(app).post(`/api/clusters/${cluster.id}/api-key`).set(authHeaders());
            expect(rotated.status).toBe(201);

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.apiKey).toBe(rotated.body.apiKey);
        });

        it("should reveal the key a cluster was created with", async () => {
            const created = await request(app)
                .post("/api/clusters")
                .set(authHeaders())
                .send({ name: "revealable" });
            expect(created.status).toBe(201);

            const res = await request(app)
                .post(`/api/clusters/${created.body.cluster.id}/api-key/reveal`)
                .set(authHeaders());
            expect(res.status).toBe(200);
            expect(res.body.apiKey).toBe(created.body.apiKey);
        });

        it("should answer 409 KEY_NOT_REVEALABLE for a key minted before the vault", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id, { revealable: false });

            const info = await request(app).get(`/api/clusters/${cluster.id}/api-key`).set(authHeaders());
            expect(info.body.revealable).toBe(false);

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(authHeaders());
            expect(res.status).toBe(409);
            expect(res.body.code).toBe("KEY_NOT_REVEALABLE");
        });

        it("should return 404 when no active key exists", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id);
            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(authHeaders());
            expect(res.status).toBe(404);
        });

        it("should not reveal another org's key", async () => {
            const db = getTestDb();
            const other = await createOrgWithOwner(db);
            const cluster = await createCluster(db, other.org.id);
            await createClusterApiKey(db, cluster.id, other.org.id, other.user.id);

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(authHeaders());
            expect(res.status).toBe(404);
        });
    });

    // -------------------------------------------------------------------------
    // DELETE /api/clusters/:id/api-key
    // -------------------------------------------------------------------------

    describe("DELETE /api/clusters/:id/api-key", () => {
        it("should revoke the cluster API key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            const { rawKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .delete(`/api/clusters/${cluster.id}/api-key`)
                .set(authHeaders());
            expect(res.status).toBe(200);

            // Key should no longer work
            const check = await request(app)
                .get("/api/clusters")
                .set(createApiKeyHeaders(rawKey));
            expect(check.status).toBe(401);
        });
    });

    // -------------------------------------------------------------------------
    // Cluster-scoped API key authentication
    // -------------------------------------------------------------------------

    describe("Cluster-scoped API key auth", () => {
        it("should authenticate the scanner surface with a cluster-scoped key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);
            const { rawKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            // The SBOM upload endpoint is authenticated and uses req.auth — a 400
            // (missing body) rather than 401/403 confirms the cluster key passed
            // auth and the sbom:write scope check
            const res = await request(app)
                .post("/v1/sboms/upload/cyclonedx")
                .set(createApiKeyHeaders(rawKey))
                .send({});

            expect(res.status).not.toBe(401);
            expect(res.status).not.toBe(403);
        });

        it("should reject API keys on management routes", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id);

            const { rawKey: clusterKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);
            const { createApiKey } = await import("../../fixtures/seed-data.js");
            const { rawKey: orgKey } = await createApiKey(db, testData.org.id, testData.user.id);

            // Neither a cluster-scoped nor an org-scoped key may reach
            // management routes — requireInternal turns both away with 403.
            for (const rawKey of [clusterKey, orgKey]) {
                const res = await request(app)
                    .get(`/api/organizations/${testData.org.id}`)
                    .set(createApiKeyHeaders(rawKey));
                expect(res.status).toBe(403);
            }
        });
    });
});
