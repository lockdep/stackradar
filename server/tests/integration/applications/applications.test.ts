import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createGitopsApplication,
    createHelmRelease,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * The delivery lens — `gitops_applications` as a sibling of `helm_releases`,
 * not a value on it.
 *
 * The tests that matter here are the ones about *separation*: a workload with
 * both layers must appear once under each, and the two unattributed buckets are
 * different sets. Collapsing either is what a single `source` column would have
 * forced.
 */
describe("GitOps application grouping", () => {
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

    it("counts what an application delivers, across namespaces", async () => {
        const db = getTestDb();
        const application = await createGitopsApplication(db, testData.org.id, testData.cluster.id, {
            name: "kube-prometheus-stack",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
            targetRevision: "82.18.0",
        });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "monitoring",
            workloadName: "kps-operator",
            applicationId: application.id,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "logging",
            workloadName: "kps-exporter",
            applicationId: application.id,
        });

        const response = await request(app).get("/api/applications").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.applications).toHaveLength(1);
        expect(response.body.applications[0]).toMatchObject({
            name: "kube-prometheus-stack",
            // Where the app object lives, not where it deploys.
            namespace: "argocd",
            targetRevision: "82.18.0",
            workloadCount: 2,
            namespaceCount: 2,
        });
    });

    /*
     * The case the two-table model exists for. `kube-prometheus-stack` is
     * legitimately a chart *and* an app; the chart version is what a CVE report
     * cites and the app is where the fix is made, so neither may displace the
     * other.
     */
    it("counts a workload that has both layers under each of them", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "kube-prometheus-stack",
            namespace: "monitoring",
            chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
        });
        const application = await createGitopsApplication(db, testData.org.id, testData.cluster.id, {
            name: "kube-prometheus-stack",
        });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "monitoring",
            workloadName: "kps-operator",
            releaseId: release.id,
            applicationId: application.id,
        });

        const [apps, releases] = await Promise.all([
            request(app).get("/api/applications").set(authHeaders()),
            request(app).get("/api/releases").set(authHeaders()),
        ]);

        expect(apps.body.applications[0].workloadCount).toBe(1);
        expect(releases.body.releases[0].workloadCount).toBe(1);
        // Exactly once in each lens, and unattributed in neither.
        expect(apps.body.undelivered.workloads).toBe(0);
        expect(releases.body.unmanaged.workloads).toBe(0);
    });

    /*
     * The two unattributed buckets are different sets, and that difference is
     * the honest answer rather than an inconsistency: the scanner itself is
     * `helm install`ed with no GitOps tool above it.
     */
    it("reports undelivered workloads separately from unmanaged ones", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "stackradar-scanner",
        });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "scanner",
            releaseId: release.id,
        });

        const [apps, releases] = await Promise.all([
            request(app).get("/api/applications").set(authHeaders()),
            request(app).get("/api/releases").set(authHeaders()),
        ]);

        expect(apps.body.undelivered.workloads).toBe(1);
        expect(releases.body.unmanaged.workloads).toBe(0);
    });

    it("scopes to the caller's org", async () => {
        const db = getTestDb();
        const other = await seedTestScenario(db);
        await createGitopsApplication(db, other.org.id, other.cluster.id, { name: "not-yours" });

        const response = await request(app).get("/api/applications").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.applications).toHaveLength(0);
    });
});
