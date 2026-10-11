import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createImage,
    createOrgWithOwner,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("GET /api/containers/:id", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
    });

    function authHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    it("returns the container with its workload, namespace and image", async () => {
        const db = getTestDb();
        const { container, image } = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "api",
            workloadKind: "StatefulSet",
            containerName: "server",
            imageTag: "1.4.2",
        });

        const response = await request(app).get(`/api/containers/${container.id}`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: container.id,
            name: "server",
            imageTag: "1.4.2",
            workloadName: "api",
            workloadKind: "StatefulSet",
            namespaceName: "prod",
            clusterId: testData.cluster.id,
            imageId: image.id,
            imageDigest: image.digest,
        });
    });

    it("carries a null kind through rather than guessing 'Pod'", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadKind: null,
        });

        const response = await request(app).get(`/api/containers/${container.id}`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.workloadKind).toBeNull();
    });

    it("returns 404 for a non-existent container", async () => {
        const response = await request(app)
            .get("/api/containers/00000000-0000-0000-0000-000000000000")
            .set(authHeaders());

        expect(response.status).toBe(404);
        expect(response.body.error).toMatch(/not found/i);
    });

    it("returns 404 for another org's container rather than leaking its existence", async () => {
        const db = getTestDb();
        const { org: otherOrg } = await createOrgWithOwner(db, {}, { name: "Other Org", slug: "other-org-2" });
        const otherCluster = await createCluster(db, otherOrg.id);
        const { container } = await seedRunningImage(db, otherOrg.id, otherCluster.id);

        const response = await request(app).get(`/api/containers/${container.id}`).set(authHeaders());

        expect(response.status).toBe(404);
    });

    it("returns 400 for an invalid UUID", async () => {
        const response = await request(app).get("/api/containers/invalid-uuid").set(authHeaders());

        expect(response.status).toBe(400);
        expect(response.body.error).toMatch(/invalid/i);
    });
});

describe("GET /api/containers/:id/siblings", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        const db = getTestDb();
        testData = await seedTestScenario(db);
    });

    function authHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    /**
     * The question the old model could not ask at all: the same image in five
     * namespaces was five unrelated projects.
     */
    it("lists every other place the same image runs", async () => {
        const db = getTestDb();
        const shared = await createImage(db, testData.org.id, testData.cluster.id, {
            digest: `sha256:${"c".repeat(64)}`,
        });

        const first = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "api",
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "staging",
            workloadName: "api",
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "dev",
            workloadName: "api",
            image: shared,
        });

        const response = await request(app).get(`/api/containers/${first.container.id}/siblings`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);
        expect(response.body.map((d: { namespaceName: string }) => d.namespaceName).sort()).toEqual(["dev", "staging"]);
    });

    it("returns an empty list when the image runs in one place", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app).get(`/api/containers/${container.id}/siblings`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
    });
});
