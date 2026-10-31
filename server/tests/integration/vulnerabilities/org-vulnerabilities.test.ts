import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createOrgWithOwner,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * GET /api/vulnerabilities — the org-wide Vulnerabilities page.
 *
 * The cluster tab's contract (`clusters/cluster-vulnerabilities.test.ts`)
 * with the scope widened to every cluster of the caller's org: one row per
 * advisory identity across all of them, the spread now also counted by
 * cluster, occurrences naming the cluster each image and workload is in, and
 * nothing from another org ever visible. Under ADR 0006 a digest in two
 * clusters is two images, so an advisory on both counts two findings here —
 * the same two the Dashboard's severity cards count.
 */
describe("org-wide vulnerabilities", () => {
    let app: Express;
    let testData: SeedTestScenarioResult;

    beforeAll(async () => {
        app = await getTestApp();
    });

    beforeEach(async () => {
        await cleanAllData();
        testData = await seedTestScenario(getTestDb());
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

    async function component(sbomId: string, name: string, version: string) {
        const [c] = await getTestDb()
            .insert(schema.components)
            .values({
                sbomId,
                name,
                version,
                purl: `pkg:npm/${name}@${version}`,
                type: "library",
                isDirect: true,
            })
            .returning();
        return c!;
    }

    async function advisory(values: {
        vulnId: string;
        severityLevel?: string | null;
        cvssScore?: number | null;
        epssScore?: number | null;
        kevListedAt?: Date | null;
        aliases?: string[] | null;
        summary?: string | null;
    }) {
        const [vuln] = await getTestDb()
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId: values.vulnId,
                        source: "osv",
                        severityLevel: values.severityLevel ?? null,
                        cvssScore: values.cvssScore ?? null,
                        epssScore: values.epssScore ?? null,
                        kevListedAt: values.kevListedAt ?? null,
                        aliases: values.aliases ?? null,
                        summary: values.summary ?? null,
                    },
                ]),
            )
            .returning();
        return vuln!;
    }

    async function finding(componentId: string, vulnerabilityId: string, fixedVersion: string | null = null) {
        await getTestDb().insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
            fixedVersion,
        });
    }

    /** One running image in each of two clusters of the org, each with lodash. */
    async function seedTwoClusters() {
        const db = getTestDb();
        const { org, cluster: clusterA } = testData;
        const clusterB = await createCluster(db, org.id);

        const a = await seedRunningImage(db, org.id, clusterA.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
        });
        const b = await seedRunningImage(db, org.id, clusterB.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        return {
            clusterA,
            clusterB,
            imageA: a.image,
            imageB: b.image,
            lodashA: await component(sbomA.id, "lodash", "4.17.21"),
            lodashB: await component(sbomB.id, "lodash", "4.17.21"),
            reactA: await component(sbomA.id, "react", "18.0.0"),
        };
    }

    it("folds one advisory across clusters into one row, counting the spread by cluster too", async () => {
        const { lodashA, lodashB, reactA } = await seedTwoClusters();

        const critical = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "critical", cvssScore: 9.8 });
        await finding(lodashA.id, critical.id, "4.17.22");
        await finding(lodashB.id, critical.id, "4.17.22");
        const high = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high", cvssScore: 8.1 });
        await finding(reactA.id, high.id);

        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(2);
        expect(response.body.totalFindings).toBe(3);
        // The critical on two images is two findings; the high is not counted.
        expect(response.body.criticalTierCounts.all).toBe(2);
        expect(response.body.severityTierCounts.critical.all).toBe(2);
        expect(response.body.severityTierCounts.high.all).toBe(1);
        const [first, second] = response.body.vulnerabilities;
        expect(first).toMatchObject({
            vulnId: "CVE-2024-0001",
            severity: "critical",
            fixAvailable: true,
            findingCount: 2,
            imageCount: 2,
            workloadCount: 2,
            clusterCount: 2,
        });
        expect(second).toMatchObject({
            vulnId: "CVE-2024-0002",
            severity: "high",
            findingCount: 1,
            clusterCount: 1,
        });
    });

    it("says where a row's findings sit: every lens bucket and image control behind it", async () => {
        const db = getTestDb();
        const { imageA, imageB, lodashA, lodashB, reactA } = await seedTwoClusters();
        await db.update(schema.images).set({ control: "built" }).where(eq(schema.images.id, imageA.id));
        await db.update(schema.images).set({ control: "third-party" }).where(eq(schema.images.id, imageB.id));
        await db.update(schema.components).set({ fromBase: false }).where(eq(schema.components.id, lodashA.id));
        await db.update(schema.components).set({ fromBase: true }).where(eq(schema.components.id, lodashB.id));
        await db.update(schema.components).set({ fromBase: false }).where(eq(schema.components.id, reactA.id));

        const both = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "critical", cvssScore: 9.8 });
        await finding(lodashA.id, both.id);
        await finding(lodashB.id, both.id);
        const one = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high", cvssScore: 8.1 });
        await finding(reactA.id, one.id);

        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());

        expect(response.status).toBe(200);
        const [first, second] = response.body.vulnerabilities;
        expect(first.buckets).toEqual(["application", "base"]);
        expect(first.controls).toEqual(["built", "third-party"]);
        expect(second.buckets).toEqual(["application"]);
        expect(second.controls).toEqual(["built"]);
    });

    it("titles a row with the advisory's own summary, and says null when no record states one", async () => {
        const { lodashA, reactA } = await seedTwoClusters();

        const titled = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            summary: "Prototype pollution in lodash",
        });
        await finding(lodashA.id, titled.id);
        const untitled = await advisory({
            vulnId: "CVE-2024-0002",
            severityLevel: "high",
            cvssScore: 8.1,
            summary: "  ",
        });
        await finding(reactA.id, untitled.id);

        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());

        expect(response.status).toBe(200);
        expect(
            response.body.vulnerabilities.map((v: { vulnId: string; summary: string | null }) => [v.vulnId, v.summary]),
        ).toEqual([
            ["CVE-2024-0001", "Prototype pollution in lodash"],
            ["CVE-2024-0002", null],
        ]);
    });

    it("agrees with the cluster tabs: the org list is their union, and a tab's clusterCount is 1", async () => {
        const { clusterA, clusterB, lodashA, lodashB } = await seedTwoClusters();
        const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
        await finding(lodashA.id, vuln.id);
        await finding(lodashB.id, vuln.id);

        const [org, tabA, tabB] = await Promise.all([
            request(app).get("/api/vulnerabilities").set(authHeaders()),
            request(app).get(`/api/clusters/${clusterA.id}/vulnerabilities`).set(authHeaders()),
            request(app).get(`/api/clusters/${clusterB.id}/vulnerabilities`).set(authHeaders()),
        ]);

        expect(org.body.totalFindings).toBe(tabA.body.totalFindings + tabB.body.totalFindings);
        expect(tabA.body.vulnerabilities[0].clusterCount).toBe(1);
        expect(tabB.body.vulnerabilities[0].clusterCount).toBe(1);
    });

    it("filters by severity and searches, with the cluster tab's parameters", async () => {
        const { lodashA, reactA } = await seedTwoClusters();
        const critical = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "critical", cvssScore: 9.8 });
        const low = await advisory({ vulnId: "CVE-2024-0004", severityLevel: "low", cvssScore: 2.0 });
        await finding(lodashA.id, critical.id);
        await finding(reactA.id, low.id);

        const onlyCritical = await request(app).get("/api/vulnerabilities?severity=critical").set(authHeaders());
        expect(onlyCritical.body.total).toBe(1);
        expect(onlyCritical.body.vulnerabilities[0].vulnId).toBe("CVE-2024-0001");

        const byPackage = await request(app).get("/api/vulnerabilities?search=react").set(authHeaders());
        expect(byPackage.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual(["CVE-2024-0004"]);
    });

    it("never lists another org's findings of the same advisory", async () => {
        const db = getTestDb();
        const { lodashA } = await seedTwoClusters();
        const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
        await finding(lodashA.id, vuln.id);

        const stranger = await createOrgWithOwner(db);
        const strangerCluster = await createCluster(db, stranger.org.id);
        const other = await seedRunningImage(db, stranger.org.id, strangerCluster.id, {
            digest: "sha256:" + "c".repeat(64),
            workloadName: "elsewhere",
        });
        const otherSbom = await createSbom(db, { imageId: other.image.id });
        await finding((await component(otherSbom.id, "lodash", "4.17.21")).id, vuln.id);

        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.totalFindings).toBe(1);
        expect(response.body.vulnerabilities[0]).toMatchObject({
            findingCount: 1,
            imageCount: 1,
            clusterCount: 1,
        });
    });

    it("returns an empty page for an org with no scans", async () => {
        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            vulnerabilities: [],
            total: 0,
            totalFindings: 0,
            unscoredFindings: 0,
            tierCounts: { application: 0, base: 0, all: 0 },
            criticalTierCounts: { application: 0, base: 0, all: 0 },
            severityTierCounts: {
                critical: { application: 0, base: 0, all: 0 },
                high: { application: 0, base: 0, all: 0 },
                medium: { application: 0, base: 0, all: 0 },
                low: { application: 0, base: 0, all: 0 },
            },
            limit: 50,
            offset: 0,
        });
    });

    it("puts a KEV-listed medium above an idle critical, across clusters", async () => {
        const { lodashA, lodashB } = await seedTwoClusters();
        const idleCritical = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            epssScore: 0.01,
        });
        const kevMedium = await advisory({
            vulnId: "CVE-2024-0002",
            severityLevel: "medium",
            cvssScore: 5.3,
            kevListedAt: new Date("2024-01-10T00:00:00Z"),
        });
        await finding(lodashA.id, idleCritical.id);
        await finding(lodashB.id, kevMedium.id);

        const response = await request(app).get("/api/vulnerabilities").set(authHeaders());
        expect(response.status).toBe(200);
        expect(
            response.body.vulnerabilities.map((v: { vulnId: string; exploited: boolean }) => [v.vulnId, v.exploited]),
        ).toEqual([
            ["CVE-2024-0002", true],
            ["CVE-2024-0001", false],
        ]);
    });

    describe("cluster and namespace filters", () => {
        /** `seedTwoClusters`, with cluster A's image also running in `staging`. */
        async function seedScoped() {
            const seeded = await seedTwoClusters();
            await seedRunningImage(getTestDb(), testData.org.id, seeded.clusterA.id, {
                image: seeded.imageA,
                namespace: "staging",
                workloadName: "api-staging",
            });
            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "critical", cvssScore: 9.8 });
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);
            return seeded;
        }

        it("narrows the list to one cluster's images with ?cluster=", async () => {
            const seeded = await seedScoped();

            const response = await request(app)
                .get(`/api/vulnerabilities?cluster=${seeded.clusterB.id}`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.totalFindings).toBe(1);
            expect(response.body.vulnerabilities).toHaveLength(1);
            expect(response.body.vulnerabilities[0]).toMatchObject({
                vulnId: "CVE-2024-0001",
                findingCount: 1,
                imageCount: 1,
                containerCount: 1,
                clusterCount: 1,
            });
        });

        it("counts only the namespace's containers under ?namespace=, and keeps the score whole", async () => {
            const seeded = await seedScoped();

            const [staging, clusterA] = await Promise.all([
                request(app).get("/api/vulnerabilities?namespace=staging").set(authHeaders()),
                request(app).get(`/api/vulnerabilities?cluster=${seeded.clusterA.id}`).set(authHeaders()),
            ]);

            expect(staging.status).toBe(200);
            expect(staging.body.totalFindings).toBe(1);
            // Image A runs in `default` and `staging`: two containers in the
            // cluster, one of them in the namespace asked about.
            expect(clusterA.body.vulnerabilities[0]).toMatchObject({ imageCount: 1, containerCount: 2 });
            expect(staging.body.vulnerabilities[0]).toMatchObject({
                imageCount: 1,
                containerCount: 1,
                workloadCount: 1,
            });
            // One finding either way — the container join must not re-weigh it.
            expect(staging.body.vulnerabilities[0].totalRiskScore).toBe(
                clusterA.body.vulnerabilities[0].totalRiskScore,
            );
        });

        it("spans clusters by namespace name, and combines with ?cluster=", async () => {
            const seeded = await seedScoped();

            const everywhere = await request(app).get("/api/vulnerabilities?namespace=default").set(authHeaders());
            expect(everywhere.body.vulnerabilities[0]).toMatchObject({
                imageCount: 2,
                containerCount: 2,
                clusterCount: 2,
            });

            const none = await request(app)
                .get(`/api/vulnerabilities?namespace=staging&cluster=${seeded.clusterB.id}`)
                .set(authHeaders());
            expect(none.body.total).toBe(0);
            expect(none.body.vulnerabilities).toEqual([]);
        });

        it("lists nothing for another org's cluster, and ignores a cluster that is not an id", async () => {
            await seedScoped();
            const db = getTestDb();
            const other = await createOrgWithOwner(db);
            const foreign = await createCluster(db, other.org.id);

            const theirs = await request(app).get(`/api/vulnerabilities?cluster=${foreign.id}`).set(authHeaders());
            expect(theirs.status).toBe(200);
            expect(theirs.body.total).toBe(0);

            const garbage = await request(app).get("/api/vulnerabilities?cluster=not-a-uuid").set(authHeaders());
            expect(garbage.status).toBe(200);
            expect(garbage.body.totalFindings).toBe(2);
        });

        it("narrows the occurrences to the namespace's containers", async () => {
            const seeded = await seedScoped();

            const response = await request(app)
                .get("/api/vulnerabilities/occurrences?identity=CVE-2024-0001&namespace=staging")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images).toHaveLength(1);
            expect(response.body.images[0]).toMatchObject({ id: seeded.imageA.id, containerCount: 1 });
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName)).toEqual([
                "api-staging",
            ]);
            expect(response.body.containers.map((c: { namespaceName: string }) => c.namespaceName)).toEqual([
                "staging",
            ]);
        });
    });

    describe("occurrences", () => {
        it("names the cluster of every image and workload, across clusters", async () => {
            const seeded = await seedTwoClusters();
            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);

            const response = await request(app)
                .get("/api/vulnerabilities/occurrences?identity=CVE-2024-0001")
                .set(authHeaders());

            expect(response.status).toBe(200);
            const byImage = Object.fromEntries(
                response.body.images.map((i: { id: string; clusterId: string; clusterName: string }) => [
                    i.id,
                    { clusterId: i.clusterId, clusterName: i.clusterName },
                ]),
            );
            expect(byImage[seeded.imageA.id]).toEqual({
                clusterId: seeded.clusterA.id,
                clusterName: seeded.clusterA.name,
            });
            expect(byImage[seeded.imageB.id]).toEqual({
                clusterId: seeded.clusterB.id,
                clusterName: seeded.clusterB.name,
            });

            const byWorkload = Object.fromEntries(
                response.body.workloads.map((w: { workloadName: string; clusterId: string }) => [
                    w.workloadName,
                    w.clusterId,
                ]),
            );
            expect(byWorkload).toEqual({ api: seeded.clusterA.id, worker: seeded.clusterB.id });
        });

        it("400s without an identity", async () => {
            const response = await request(app).get("/api/vulnerabilities/occurrences").set(authHeaders());
            expect(response.status).toBe(400);
        });
    });

    describe("detail", () => {
        it("returns the advisory records and fixes behind an identity, org-wide", async () => {
            const { lodashA, lodashB } = await seedTwoClusters();
            const cve = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high", cvssScore: 8.1 });
            const ghsa = await advisory({
                vulnId: "GHSA-aaaa-bbbb-cccc",
                severityLevel: "critical",
                cvssScore: 9.1,
                aliases: ["CVE-2024-0001"],
                summary: "Prototype pollution in lodash",
            });
            // The CVE stub is only in cluster A; the GHSA only in cluster B.
            await finding(lodashA.id, cve.id);
            await finding(lodashB.id, ghsa.id, "4.17.22");

            const response = await request(app)
                .get("/api/vulnerabilities/detail?identity=CVE-2024-0001")
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.advisories.map((a: { vulnId: string }) => a.vulnId)).toEqual([
                "GHSA-aaaa-bbbb-cccc",
                "CVE-2024-0001",
            ]);
            expect(response.body.fixes).toEqual([{ packageName: "lodash", fixedVersion: "4.17.22" }]);
        });

        it("does not confuse the fixed segments with an advisory id", async () => {
            // `/detail` and `/occurrences` are declared before `/:vulnId`; a
            // missing identity must be their 400, not a 404 from the lookup.
            const response = await request(app).get("/api/vulnerabilities/detail").set(authHeaders());
            expect(response.status).toBe(400);
        });
    });
});
