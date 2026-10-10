import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

async function resetSyncState() {
    const db = getTestDb();
    await db.delete(schema.osvSyncState);
}

describe("POST /api/vulnerabilities/sync/all", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        await resetSyncState();
        testData = await seedTestScenario(getTestDb());
    });

    /**
     * Re-matching every component of every stored SBOM is fleet-level work
     * charged to nobody's org, so it is admin-only.
     */
    function adminHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
            isAdmin: true,
        });
    }

    it("returns 200 with zero components processed when DB is empty", async () => {
        const response = await request(app)
            .post("/api/vulnerabilities/sync/all")
            .set(adminHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            message: "Full vulnerability sync completed",
            componentsProcessed: 0,
            totalVulnerabilitiesFound: 0,
        });
    });

    it("returns 503 when the OSV mirror has never completed an import", async () => {
        const db = getTestDb();
        await db.insert(schema.osvSyncState).values({ id: 1, initialized: false });

        const response = await request(app)
            .post("/api/vulnerabilities/sync/all")
            .set(adminHeaders());

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
            error: expect.any(String),
            reason: "not_initialized",
        });
    });

    it("returns 200 during a full refresh of an already-initialized mirror", async () => {
        // The rebuild writes a new generation beside the live one, so there is
        // a complete mirror to read throughout — no reason to refuse the call.
        const db = getTestDb();
        await db.insert(schema.osvSyncState).values({
            id: 1,
            initialized: true,
            syncStatus: "full_refresh",
        });

        const response = await request(app)
            .post("/api/vulnerabilities/sync/all")
            .set(adminHeaders());

        expect(response.status).toBe(200);
    });

    it("403s for a non-admin member", async () => {
        const response = await request(app)
            .post("/api/vulnerabilities/sync/all")
            .set(createInternalHeaders({
                id: testData.user.id,
                email: testData.user.email,
                orgId: testData.org.id,
                orgName: testData.org.name,
                orgSlug: testData.org.slug,
            }));

        expect(response.status).toBe(403);
    });

    it("refuses an unauthenticated caller", async () => {
        const response = await request(app).post("/api/vulnerabilities/sync/all");
        expect(response.status).toBe(401);
    });
});

describe("POST /api/vulnerabilities/sync/image/:imageId", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        await resetSyncState();
        testData = await seedTestScenario(getTestDb());
    });

    /**
     * Every sync trigger is admin-only: rescans are the system's decision
     * (SBOM upload, the post-sync fleet rescan), and these routes are
     * operator escape hatches. A plain member gets 403 — see the test below.
     */
    function adminHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
            isAdmin: true,
        });
    }

    function memberHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    it("returns 200 with zero components processed for an image with no components", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/image/${image.id}`)
            .set(adminHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            message: "Vulnerability sync completed",
            componentsProcessed: 0,
        });
    });

    /**
     * Not a data leak on its own, but it was an unbounded lever on any digest
     * in the fleet for anyone who could guess a UUID.
     */
    it("404s on an image belonging to another org", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-sync" });
        const { image } = await seedRunningImage(db, other.org.id, other.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/image/${image.id}`)
            .set(adminHeaders());

        expect(response.status).toBe(404);
    });

    /**
     * An uploaded-but-not-yet-inventoried image is the owner's upload: since
     * images are cluster-scoped it is visible to its org before any workload
     * references it, and still invisible to everyone else.
     */
    it("200s on an undeployed image the org owns, 404s for another org's", async () => {
        const db = getTestDb();
        const image = await createImage(db, testData.org.id, testData.cluster.id);

        const owner = await request(app)
            .post(`/api/vulnerabilities/sync/image/${image.id}`)
            .set(adminHeaders());
        expect(owner.status).toBe(200);

        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-undeployed" });
        const theirImage = await createImage(db, other.org.id, other.cluster.id);
        const response = await request(app)
            .post(`/api/vulnerabilities/sync/image/${theirImage.id}`)
            .set(adminHeaders());
        expect(response.status).toBe(404);
    });

    it("403s for a non-admin member, even on an image their org runs", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/image/${image.id}`)
            .set(memberHeaders());

        expect(response.status).toBe(403);
    });

    it("refuses an unauthenticated caller", async () => {
        const image = await createImage(getTestDb(), testData.org.id, testData.cluster.id);
        const response = await request(app)
            .post(`/api/vulnerabilities/sync/image/${image.id}`);

        expect(response.status).toBe(401);
    });
});

describe("POST /api/vulnerabilities/sync/component/:componentId", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        await resetSyncState();
        testData = await seedTestScenario(getTestDb());
    });

    /**
     * Every sync trigger is admin-only: rescans are the system's decision
     * (SBOM upload, the post-sync fleet rescan), and these routes are
     * operator escape hatches. A plain member gets 403 — see the test below.
     */
    function adminHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
            isAdmin: true,
        });
    }

    function memberHeaders(): Record<string, string> {
        return createInternalHeaders({
            id: testData.user.id,
            email: testData.user.email,
            orgId: testData.org.id,
            orgName: testData.org.name,
            orgSlug: testData.org.slug,
        });
    }

    async function seedOwnedComponent(orgId: string, clusterId: string) {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, orgId, clusterId);
        const sbom = await createSbom(db, { imageId: image.id });
        const [component] = await db.insert(schema.components).values({
            sbomId: sbom.id,
            name: "no-such-package",
            version: "1.0.0",
            type: "library",
            purl: "pkg:npm/no-such-package@1.0.0",
        }).returning();
        return component!;
    }

    it("returns 200 with zero vulnerabilities found when the OSV mirror is empty", async () => {
        const component = await seedOwnedComponent(testData.org.id, testData.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/component/${component.id}`)
            .set(adminHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            message: "Component vulnerability sync completed",
            componentId: component.id,
            vulnerabilitiesFound: 0,
        });
    });

    it("404s on a component belonging to another org", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db, {}, { name: "Other", slug: "other-comp-sync" });
        const component = await seedOwnedComponent(other.org.id, other.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/component/${component.id}`)
            .set(adminHeaders());

        expect(response.status).toBe(404);
    });

    it("403s for a non-admin member, even on a component their org owns", async () => {
        const component = await seedOwnedComponent(testData.org.id, testData.cluster.id);

        const response = await request(app)
            .post(`/api/vulnerabilities/sync/component/${component.id}`)
            .set(memberHeaders());

        expect(response.status).toBe(403);
    });
});
