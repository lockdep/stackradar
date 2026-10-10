import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createNamespace,
    createSbom,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("GET /api/namespaces", () => {
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
     * The state the old `type: "group"` row could not represent: a group with
     * no children was indistinguishable from one that was never created.
     */
    it("includes a namespace with zero workloads", async () => {
        const db = getTestDb();
        await createNamespace(db, testData.org.id, testData.cluster.id, { name: "empty" });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { namespace: "busy" });

        const response = await request(app).get("/api/namespaces").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);

        const empty = response.body.find((n: { name: string }) => n.name === "empty");
        expect(empty).toMatchObject({ workloadCount: 0, containerCount: 0, scannedCount: 0 });

        const busy = response.body.find((n: { name: string }) => n.name === "busy");
        expect(busy).toMatchObject({ workloadCount: 1, containerCount: 1 });
    });

    /**
     * `null` (RBAC absent, not collected) and `{}` (collected, none present)
     * are different facts and must survive the round trip apart.
     */
    it("preserves null vs {} for namespace labels", async () => {
        const db = getTestDb();
        await createNamespace(db, testData.org.id, testData.cluster.id, { name: "uncollected", labels: null });
        await createNamespace(db, testData.org.id, testData.cluster.id, { name: "unlabelled", labels: {} });
        await createNamespace(db, testData.org.id, testData.cluster.id, {
            name: "labelled",
            labels: { environment: "prod" },
        });

        const response = await request(app).get("/api/namespaces").set(authHeaders());
        const byName = new Map(response.body.map((n: { name: string }) => [n.name, n]));

        expect((byName.get("uncollected") as { labels: unknown }).labels).toBeNull();
        expect((byName.get("unlabelled") as { labels: unknown }).labels).toEqual({});
        expect((byName.get("labelled") as { labels: unknown }).labels).toEqual({ environment: "prod" });
    });

    /**
     * `scannedCount` counts containers whose image has an SBOM, not distinct
     * scanned images — the two diverge the moment two containers share one
     * image, and the ratio the UI draws is over containers.
     */
    it("counts covered containers, not distinct scanned images", async () => {
        const db = getTestDb();
        const shared = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"d".repeat(64)}` });
        await createSbom(db, { imageId: shared.id });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "api",
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "web",
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "worker",
        });

        const response = await request(app).get("/api/namespaces").set(authHeaders());
        const prod = response.body.find((n: { name: string }) => n.name === "prod");

        expect(prod.containerCount).toBe(3);
        // Two containers covered by one image, not one.
        expect(prod.scannedCount).toBe(2);
        expect(prod.scannedCount).toBeLessThanOrEqual(prod.containerCount);
    });

    it("rejects unauthenticated requests with 401", async () => {
        const response = await request(app).get("/api/namespaces");
        expect(response.status).toBe(401);
    });
});
