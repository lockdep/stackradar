import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("workload detail sub-resources", () => {
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

    it("returns an empty component list for an unscanned image", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/workloads/${container.id}/components`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
    });

    it("returns an empty dependency tree for an unscanned image", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/workloads/${container.id}/dependency-tree`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ components: [], dependencies: [] });
    });

    /**
     * A digest has exactly one SBOM forever, so this endpoint returns 0 or 1
     * rows — the list shape survives only because "not scanned yet" has to be
     * expressible without a 404.
     */
    it("returns the image's single SBOM, with deployment facts off the container", async () => {
        const db = getTestDb();
        const { container, image } = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            imageTag: "2.1.0",
        });
        const sbom = await createSbom(db, { imageId: image.id });

        const response = await request(app)
            .get(`/api/workloads/${container.id}/sboms`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
            id: sbom.id,
            imageId: image.id,
            // The tag comes from the container, not the SBOM — the SBOM
            // describes bytes and carries no deployment context at all.
            imageTag: "2.1.0",
        });
    });

    it("returns an empty SBOM list rather than 404 when nothing has scanned the image", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/workloads/${container.id}/sboms`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
    });

    it("returns an empty scan history for an unscanned image", async () => {
        const db = getTestDb();
        const { container } = await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app)
            .get(`/api/workloads/${container.id}/scan-history`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
    });

    it("404s every sub-resource for a non-existent container", async () => {
        const missing = "00000000-0000-0000-0000-000000000000";
        for (const path of ["components", "dependency-tree", "vulnerabilities", "sboms", "scan-history", "siblings"]) {
            const response = await request(app)
                .get(`/api/workloads/${missing}/${path}`)
                .set(authHeaders());
            expect(response.status, path).toBe(404);
        }
    });
});
