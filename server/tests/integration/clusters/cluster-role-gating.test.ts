/**
 * Role gating on cluster management — the UI presents cluster CRUD and API
 * key rotation as admin functionality ("members can only view"), so the
 * server enforces admin-or-owner on every cluster mutation via the
 * `requireAdminOrOwner` middleware. Reads (list, detail, masked API key
 * metadata) stay member-accessible.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    createOrgWithOwner,
    createUser,
    addOrgMember,
    createCluster,
    createClusterApiKey,
    type CreateOrgWithOwnerResult,
} from "../../fixtures/seed-data.js";
import type * as schema from "../../../src/db/schema/index.js";

describe("Cluster role gating", () => {
    let app: Express;
    let testData: CreateOrgWithOwnerResult;
    let member: schema.User;
    let admin: schema.User;

    function headersFor(user: schema.User) {
        return createInternalHeaders({
            id: user.id,
            email: user.email,
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
        const db = getTestDb();
        testData = await createOrgWithOwner(db);
        member = await createUser(db);
        await addOrgMember(db, member.id, testData.org.id, "member");
        admin = await createUser(db);
        await addOrgMember(db, admin.id, testData.org.id, "admin");
    });

    describe("member mutations are forbidden", () => {
        it("should return 403 when a member creates a cluster", async () => {
            const res = await request(app)
                .post("/api/clusters")
                .set(headersFor(member))
                .send({ name: "member-cluster" });
            expect(res.status).toBe(403);
            expect(res.body.error).toBe("Admin or owner role required");
        });

        it("should return 403 when a member updates a cluster", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(headersFor(member))
                .send({ name: "renamed" });
            expect(res.status).toBe(403);
        });

        it("should return 403 when a member deletes a cluster", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app)
                .delete(`/api/clusters/${cluster.id}`)
                .set(headersFor(member));
            expect(res.status).toBe(403);
        });

        it("should return 403 when a member reveals the API key, and 200 for an admin", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            const { rawKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const denied = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(headersFor(member));
            expect(denied.status).toBe(403);
            expect(denied.body.error).toBe("Admin or owner role required");
            expect(denied.body.apiKey).toBeUndefined();

            const allowed = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key/reveal`)
                .set(headersFor(admin));
            expect(allowed.status).toBe(200);
            expect(allowed.body.apiKey).toBe(rawKey);
        });

        it("should return 403 when a member rotates a cluster API key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key`)
                .set(headersFor(member));
            expect(res.status).toBe(403);
        });

        it("should return 403 when a member revokes a cluster API key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .delete(`/api/clusters/${cluster.id}/api-key`)
                .set(headersFor(member));
            expect(res.status).toBe(403);
        });
    });

    describe("member reads still work", () => {
        it("should let a member list clusters", async () => {
            await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app).get("/api/clusters").set(headersFor(member));
            expect(res.status).toBe(200);
            expect(res.body.clusters).toHaveLength(1);
        });

        it("should let a member read a cluster by id", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app)
                .get(`/api/clusters/${cluster.id}`)
                .set(headersFor(member));
            expect(res.status).toBe(200);
            expect(res.body.cluster.id).toBe(cluster.id);
        });

        it("should let a member read the masked API key metadata", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            const { rawKey } = await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const res = await request(app)
                .get(`/api/clusters/${cluster.id}/api-key`)
                .set(headersFor(member));
            expect(res.status).toBe(200);
            // Masked metadata only — the response must never carry key material.
            expect(res.body.apiKey).toContain("••••");
            expect(JSON.stringify(res.body)).not.toContain(rawKey);
        });
    });

    describe("admin mutations succeed", () => {
        it("should let an admin create a cluster", async () => {
            const res = await request(app)
                .post("/api/clusters")
                .set(headersFor(admin))
                .send({ name: "admin-cluster" });
            expect(res.status).toBe(201);
        });

        it("should let an admin update a cluster", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app)
                .patch(`/api/clusters/${cluster.id}`)
                .set(headersFor(admin))
                .send({ name: "renamed" });
            expect(res.status).toBe(200);
        });

        it("should let an admin rotate and revoke the cluster API key", async () => {
            const db = getTestDb();
            const cluster = await createCluster(db, testData.org.id, { name: "prod" });
            await createClusterApiKey(db, cluster.id, testData.org.id, testData.user.id);

            const rotated = await request(app)
                .post(`/api/clusters/${cluster.id}/api-key`)
                .set(headersFor(admin));
            expect(rotated.status).toBe(201);

            const revoked = await request(app)
                .delete(`/api/clusters/${cluster.id}/api-key`)
                .set(headersFor(admin));
            expect(revoked.status).toBe(200);
        });

        it("should let an admin delete a cluster", async () => {
            const cluster = await createCluster(getTestDb(), testData.org.id, { name: "prod" });
            const res = await request(app)
                .delete(`/api/clusters/${cluster.id}`)
                .set(headersFor(admin));
            expect(res.status).toBe(200);
        });
    });

    describe("owner mutations succeed", () => {
        it("should let the owner create and delete a cluster", async () => {
            const created = await request(app)
                .post("/api/clusters")
                .set(headersFor(testData.user))
                .send({ name: "owner-cluster" });
            expect(created.status).toBe(201);

            const deleted = await request(app)
                .delete(`/api/clusters/${created.body.cluster.id}`)
                .set(headersFor(testData.user));
            expect(deleted.status).toBe(200);
        });
    });
});
