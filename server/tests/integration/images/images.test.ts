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
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("GET /api/images", () => {
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

    /** One row per thing a remediation acts on, however many workloads share it. */
    it("returns one row for an image running in five namespaces", async () => {
        const db = getTestDb();
        const shared = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"f".repeat(64)}` });

        for (const ns of ["a", "b", "c", "d", "e"]) {
            await seedRunningImage(db, testData.org.id, testData.cluster.id, {
                namespace: ns,
                workloadName: "api",
                image: shared,
            });
        }

        const response = await request(app).get("/api/images").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
            id: shared.id,
            digest: shared.digest,
            containerCount: 5,
        });
    });

    it("reports vulnerabilities as null until something has scanned the image", async () => {
        const db = getTestDb();
        await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app).get("/api/images").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body[0].vulnerabilities).toBeNull();
        expect(response.body[0].sbomId).toBeNull();
    });

    it("attaches the image's SBOM once it exists", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);
        const sbom = await createSbom(db, { imageId: image.id });

        const response = await request(app).get("/api/images").set(authHeaders());

        expect(response.body[0].sbomId).toBe(sbom.id);
        expect(response.body[0].scannedAt).not.toBeNull();
    });

    /**
     * `images` is cluster-scoped: the other org's row carries its own
     * `orgId`, so it must never surface here.
     */
    it("does not return an image the org does not run", async () => {
        const db = getTestDb();
        const { org: otherOrg } = await createOrgWithOwner(db, {}, { name: "Other", slug: "other-img" });
        const otherCluster = await createCluster(db, otherOrg.id);
        const { image } = await seedRunningImage(db, otherOrg.id, otherCluster.id);

        const list = await request(app).get("/api/images").set(authHeaders());
        expect(list.body).toEqual([]);

        const detail = await request(app).get(`/api/images/${image.id}`).set(authHeaders());
        expect(detail.status).toBe(404);
    });

    it("lists every deployment of an image", async () => {
        const db = getTestDb();
        const shared = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"9".repeat(64)}` });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "api",
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "staging",
            workloadName: "api",
            image: shared,
        });

        const response = await request(app)
            .get(`/api/images/${shared.id}/deployments`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);
        expect(response.body.map((d: { namespaceName: string }) => d.namespaceName).sort()).toEqual([
            "prod",
            "staging",
        ]);
    });

    it("reports an unscanned image's findings as empty, not missing", async () => {
        const db = getTestDb();
        const { image } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/images/${image.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            summary: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
            hasDependencies: false,
            groups: [],
            currentSbom: null,
            vulnScan: { status: "not_started" },
        });
    });

    it("hides another org's image's findings behind a 404", async () => {
        const db = getTestDb();
        const { org: otherOrg } = await createOrgWithOwner(db, {}, { name: "Other", slug: "other-img-findings" });
        const otherCluster = await createCluster(db, otherOrg.id);
        const { image } = await seedRunningImage(db, otherOrg.id, otherCluster.id);
        await createSbom(db, { imageId: image.id });

        const response = await request(app)
            .get(`/api/images/${image.id}/vulnerabilities/grouped`)
            .set(authHeaders());

        expect(response.status).toBe(404);
    });

    it("rejects unauthenticated requests with 401", async () => {
        const response = await request(app).get("/api/images");
        expect(response.status).toBe(401);
    });
});
