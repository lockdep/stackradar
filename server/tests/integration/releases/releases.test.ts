import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createHelmRelease,
    createImage,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

describe("Helm release grouping", () => {
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
     * A chart may deploy resources into namespaces other than the release's
     * own. Grouping by the *workload's* namespace instead of the release's
     * silently splits one release into several, which is the trap this covers.
     */
    it("groups a release's workloads even when they sit in another namespace", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "prod-redis",
            namespace: "prod",
            chartName: "redis",
            chartVersion: "18.2.1",
        });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "prod",
            workloadName: "redis-master",
            releaseId: release.id,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            namespace: "redis-data",
            workloadName: "redis-replica",
            releaseId: release.id,
        });

        const response = await request(app)
            .get(`/api/releases/${release.id}`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.workloads).toHaveLength(2);
        expect(response.body.namespaces.sort()).toEqual(["prod", "redis-data"]);
        expect(response.body.release.namespace).toBe("prod");
    });

    it("lists a release's distinct images, deduplicated", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, { name: "app" });
        const shared = await createImage(db, testData.org.id, testData.cluster.id, { digest: `sha256:${"e".repeat(64)}` });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "one",
            releaseId: release.id,
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "two",
            releaseId: release.id,
            image: shared,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "three",
            releaseId: release.id,
        });

        const response = await request(app)
            .get(`/api/releases/${release.id}`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.workloads).toHaveLength(3);
        // Three workloads, two images — the whole point of the remediation lens.
        expect(response.body.images).toHaveLength(2);
    });

    /**
     * Workloads no chart manages are the common case, and a release-grouped
     * view that omits them under-reports the fleet invisibly — those rows have
     * no group to be missing from.
     */
    it("reports unmanaged workloads as a visible count rather than hiding them", async () => {
        const db = getTestDb();
        const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, { name: "managed-app" });

        await seedRunningImage(db, testData.org.id, testData.cluster.id, {
            workloadName: "managed",
            releaseId: release.id,
        });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "unmanaged-a" });
        await seedRunningImage(db, testData.org.id, testData.cluster.id, { workloadName: "unmanaged-b" });

        const response = await request(app).get("/api/releases").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.releases).toHaveLength(1);
        expect(response.body.unmanaged).toEqual({ workloads: 2, containers: 2 });
    });

    /**
     * Several repositories publish `nginx`. Until `repoUrl` is known,
     * fleet-wide "all releases of chart X" is a name match, and the API says so
     * rather than implying the releases are the same chart.
     */
    it("flags charts that share a name across unknown or differing repositories", async () => {
        const db = getTestDb();
        await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "nginx-a",
            namespace: "a",
            chartName: "nginx",
            repoUrl: null,
        });
        await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "nginx-b",
            namespace: "b",
            chartName: "nginx",
            repoUrl: null,
        });
        await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "solo",
            namespace: "c",
            chartName: "postgres",
            repoUrl: null,
        });

        const response = await request(app).get("/api/releases").set(authHeaders());
        const byName = new Map(
            response.body.releases.map((r: { name: string }) => [r.name, r])
        );

        expect((byName.get("nginx-a") as { chartNameAmbiguous: boolean }).chartNameAmbiguous).toBe(true);
        expect((byName.get("nginx-b") as { chartNameAmbiguous: boolean }).chartNameAmbiguous).toBe(true);
        // A lone release of a chart has nothing to be merged with.
        expect((byName.get("solo") as { chartNameAmbiguous: boolean }).chartNameAmbiguous).toBe(false);
    });

    it("does not flag two releases of the same chart from the same known repo", async () => {
        const db = getTestDb();
        await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "nginx-a",
            namespace: "a",
            chartName: "nginx",
            repoUrl: "https://charts.bitnami.com/bitnami",
        });
        await createHelmRelease(db, testData.org.id, testData.cluster.id, {
            name: "nginx-b",
            namespace: "b",
            chartName: "nginx",
            repoUrl: "https://charts.bitnami.com/bitnami",
        });

        const response = await request(app).get("/api/releases").set(authHeaders());

        for (const release of response.body.releases) {
            expect(release.chartNameAmbiguous).toBe(false);
        }
    });

    /**
     * The Charts tab's second question, after "what is installed": is there a
     * newer one. The mirror is the only source that can answer it for a chart
     * nobody else in the org runs, and the list carries it so the answer costs
     * an eye sweep rather than a page visit per release.
     */
    describe("Artifact Hub match on the list", () => {
        const REPO_URL = "https://charts.jetstack.io";

        async function attributeCertManager(orgId: string): Promise<void> {
            const db = getTestDb();
            const [pkg] = await db
                .insert(schema.artifactHubPackages)
                .values({
                    name: "cert-manager",
                    repoName: "jetstack",
                    repoUrl: REPO_URL,
                    latestVersion: "v1.20.0",
                    versions: [
                        { pkg: "v1.20.0", app: "v1.20.0", kube: null, deprecated: false },
                        { pkg: "v1.19.2", app: "v1.19.2", kube: null, deprecated: false },
                    ],
                    lastSeenAt: new Date(),
                })
                .returning();

            await db.insert(schema.chartAttributions).values({
                orgId,
                chartName: "cert-manager",
                packageId: pkg!.id,
                repoUrl: REPO_URL,
                evidence: {},
                matchedAt: new Date(),
            });
        }

        it("names the matched package and the newer version it lists", async () => {
            const db = getTestDb();
            await attributeCertManager(testData.org.id);
            await createHelmRelease(db, testData.org.id, testData.cluster.id, {
                name: "cert-manager",
                namespace: "cert-manager",
                chartName: "cert-manager",
                chartVersion: "v1.19.2",
                repoUrl: REPO_URL,
            });

            const response = await request(app).get("/api/releases").set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.releases[0].artifactHub).toMatchObject({
                repoName: "jetstack",
                url: "https://artifacthub.io/packages/helm/jetstack/cert-manager",
                // The scanner observed the repo the package publishes from, so
                // the match is a confirmation rather than an inference.
                inferred: false,
                newerVersion: "v1.20.0",
                deprecated: false,
            });
        });

        /**
         * Several repositories publish `cert-manager`. An attribution is per
         * `(org, chart)`, so a release whose *observed* repo disagrees with it
         * is a different chart wearing the same name — and a link claiming
         * otherwise is the name collision `chartNameAmbiguous` exists to warn
         * about, with a URL attached.
         */
        it("says nothing for a release whose observed repo is not the matched one", async () => {
            const db = getTestDb();
            await attributeCertManager(testData.org.id);
            await createHelmRelease(db, testData.org.id, testData.cluster.id, {
                name: "cert-manager",
                namespace: "other",
                chartName: "cert-manager",
                chartVersion: "v1.19.2",
                repoUrl: "https://charts.example.com/mirror",
            });

            const response = await request(app).get("/api/releases").set(authHeaders());

            expect(response.body.releases[0].artifactHub).toBeNull();
        });

        it("is null for a chart the nightly pass never matched", async () => {
            const db = getTestDb();
            await createHelmRelease(db, testData.org.id, testData.cluster.id, {
                name: "in-house",
                chartName: "in-house",
                chartVersion: "0.1.0",
                repoUrl: null,
            });

            const response = await request(app).get("/api/releases").set(authHeaders());

            expect(response.body.releases[0].artifactHub).toBeNull();
        });
    });

    it("returns 404 for another org's release", async () => {
        const response = await request(app)
            .get("/api/releases/00000000-0000-0000-0000-000000000000")
            .set(authHeaders());

        expect(response.status).toBe(404);
    });
});
