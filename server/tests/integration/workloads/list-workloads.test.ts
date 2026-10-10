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
    createWorkloadContainer,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("GET /api/workloads", () => {
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

    it("lists running containers for the authenticated org only", async () => {
        const db = getTestDb();

        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "api" });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "web" });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "worker" });

        const response = await request(app).get("/api/workloads").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(3);
        expect(response.body.map((w: { workloadName: string }) => w.workloadName).sort()).toEqual([
            "api",
            "web",
            "worker",
        ]);
    });

    it("returns an empty array when nothing is running", async () => {
        const response = await request(app).get("/api/workloads").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
    });

    it("does not leak workloads from other organizations", async () => {
        const db = getTestDb();
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "ours" });

        const { org: otherOrg } = await createOrgWithOwner(db, {}, { name: "Other Org", slug: "other-org" });
        const otherCluster = await createCluster(db, otherOrg.id);
        await seedRunningImage(db, otherOrg.id, otherCluster.id, { workloadName: "theirs" });

        const response = await request(app).get("/api/workloads").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(1);
        expect(response.body[0].workloadName).toBe("ours");
    });

    /**
     * The three lenses are filters over one list. This is the shape the
     * group-by control on the workloads page uses, and it is why grouping
     * needed no new hierarchy.
     */
    it("filters by namespace, image and cluster", async () => {
        const db = getTestDb();
        const shared = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"a".repeat(64)}` });

        const prod = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
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
            namespace: "staging",
            workloadName: "other",
        });

        const byNamespace = await request(app)
            .get(`/api/workloads?namespaceId=${prod.namespace.id}`)
            .set(authHeaders());
        expect(byNamespace.status).toBe(200);
        expect(byNamespace.body).toHaveLength(1);
        expect(byNamespace.body[0].namespaceName).toBe("prod");

        const byImage = await request(app)
            .get(`/api/workloads?imageId=${shared.id}`)
            .set(authHeaders());
        expect(byImage.status).toBe(200);
        expect(byImage.body).toHaveLength(2);

        const byCluster = await request(app)
            .get(`/api/workloads?clusterId=${testData.cluster.id}`)
            .set(authHeaders());
        expect(byCluster.body).toHaveLength(3);
    });

    /**
     * The reason container identity includes the digest. A model keyed only on
     * `(workload, containerName)` cannot hold both rows, so it would report the
     * fix as deployed while the old digest is still serving traffic.
     */
    it("reports a mid-rollout Deployment as two rows on one container name", async () => {
        const db = getTestDb();
        const oldImage = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"1".repeat(64)}` });
        const newImage = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"2".repeat(64)}` });

        const { workload } = await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "api",
            containerName: "app",
            image: oldImage,
        });
        await createWorkloadContainer(db, testData.org.id, workload.id, newImage.id, {
            name: "app",
            runningPods: 2,
        });

        const response = await request(app).get("/api/workloads").set(authHeaders());

        expect(response.status).toBe(200);
        const app_rows = response.body.filter((w: { name: string }) => w.name === "app");
        expect(app_rows).toHaveLength(2);
        expect(app_rows.map((r: { imageDigest: string }) => r.imageDigest).sort()).toEqual([
            oldImage.digest,
            newImage.digest,
        ].sort());
    });

    it("reports `vulnerabilities: null` for an image nobody has scanned", async () => {
        const db = getTestDb();
        await seedRunningImage(db, testData.org.id, testData.cluster.id);

        const response = await request(app).get("/api/workloads").set(authHeaders());

        expect(response.status).toBe(200);
        // Not zeroes. "We have not looked" and "we looked and it is clean" are
        // very different things to tell someone about a production workload.
        expect(response.body[0].vulnerabilities).toBeNull();
        expect(response.body[0].sbomId).toBeNull();
    });

    it("rejects unauthenticated requests with 401", async () => {
        const response = await request(app).get("/api/workloads");
        expect(response.status).toBe(401);
    });
});
