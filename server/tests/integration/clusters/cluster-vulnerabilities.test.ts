import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
// Schema only — importing src/db/index.js here would eagerly connect the
// app's client before the test container's DATABASE_URL is set.
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createOrgWithOwner,
    createSbom,
    createWorkloadContainer,
    createHelmRelease,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * GET /api/clusters/:id/vulnerabilities — the Vulnerabilities tab.
 *
 * The contract under test: one row per advisory *identity* across every
 * scanned image of ONE cluster (aliases collapsed exactly as everywhere
 * else), spread counted by package, image and workload, `totalFindings`
 * counting the finding unit the Overview severity cards count, the severity
 * filter applied per finding, and nothing from any other cluster or org ever
 * visible.
 */
describe("cluster vulnerabilities tab", () => {
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

    async function component(sbomId: string, name: string, version: string) {
        const db = getTestDb();
        const [c] = await db
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
        severitySource?: string | null;
        epssScore?: number | null;
        aliases?: string[] | null;
        summary?: string | null;
        kevListedAt?: Date | null;
        kevDueDate?: Date | null;
        kevRansomware?: string | null;
        publishedAt?: Date | null;
    }) {
        const db = getTestDb();
        const [vuln] = await db
            .insert(schema.vulnerabilities)
            .values(
                withFindingIdentity([
                    {
                        vulnId: values.vulnId,
                        source: "osv",
                        severityLevel: values.severityLevel ?? null,
                        cvssScore: values.cvssScore ?? null,
                        severitySource: values.severitySource ?? null,
                        epssScore: values.epssScore ?? null,
                        aliases: values.aliases ?? null,
                        summary: values.summary ?? null,
                        kevListedAt: values.kevListedAt ?? null,
                        kevDueDate: values.kevDueDate ?? null,
                        kevRansomware: values.kevRansomware ?? null,
                        publishedAt: values.publishedAt ?? null,
                    },
                ]),
            )
            .returning();
        return vuln!;
    }

    async function finding(
        componentId: string,
        vulnerabilityId: string,
        options: { confidence?: string; fixedVersion?: string | null } = {},
    ) {
        const db = getTestDb();
        await db.insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: options.confidence ?? "exact",
            fixedVersion: options.fixedVersion ?? null,
        });
    }

    /** Two running images, one shared package, one image-A-only package. */
    async function seedTwoImages() {
        const db = getTestDb();
        const { org, cluster } = testData;

        const a = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });

        const b = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
        });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        const lodashA = await component(sbomA.id, "lodash", "4.17.21");
        const lodashB = await component(sbomB.id, "lodash", "4.17.21");
        const reactA = await component(sbomA.id, "react", "18.0.0");

        return { lodashA, lodashB, reactA, imageA: a.image, imageB: b.image, workloadA: a.workload };
    }

    it("collapses one advisory across images into one row, with the spread counted", async () => {
        const { lodashA, lodashB, reactA } = await seedTwoImages();

        const critical = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
        });
        await finding(lodashA.id, critical.id, { fixedVersion: "4.17.22" });
        await finding(lodashB.id, critical.id, { fixedVersion: "4.17.22" });

        const high = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high", cvssScore: 8.1 });
        await finding(reactA.id, high.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(2);
        // Three findings: the critical on two images' lodash, the high once.
        expect(response.body.totalFindings).toBe(3);
        expect(response.body.vulnerabilities).toHaveLength(2);

        // Worst first: critical before high.
        const [first, second] = response.body.vulnerabilities;
        expect(first).toMatchObject({
            identity: "CVE-2024-0001",
            vulnId: "CVE-2024-0001",
            severity: "critical",
            cvssScore: 9.8,
            packages: [{ name: "lodash", version: "4.17.21", fixedVersion: "4.17.22", purlType: "npm" }],
            fixAvailable: true,
            findingCount: 2,
            imageCount: 2,
            workloadCount: 2,
        });
        expect(second).toMatchObject({
            identity: "CVE-2024-0002",
            severity: "high",
            packages: [{ name: "react", version: "18.0.0", fixedVersion: null, purlType: "npm" }],
            fixAvailable: false,
            findingCount: 1,
            imageCount: 1,
            workloadCount: 1,
        });
        // lodash@4.17.21 on two images is one upgrade.
        expect(first.packageCount).toBe(1);
        expect(second.packageCount).toBe(1);
    });

    it("counts each affected package version once, and sorts by that count and by CVSS", async () => {
        const { lodashA, lodashB, reactA } = await seedTwoImages();
        // A second lodash version on image B: two upgrades, not one.
        const lodashOld = await component(lodashB.sbomId, "lodash", "4.17.15");

        const wide = await advisory({ vulnId: "CVE-2024-0010", severityLevel: "medium", cvssScore: 5.3 });
        await finding(lodashA.id, wide.id);
        await finding(lodashB.id, wide.id);
        await finding(lodashOld.id, wide.id);

        const narrow = await advisory({ vulnId: "CVE-2024-0011", severityLevel: "critical", cvssScore: 9.1 });
        await finding(reactA.id, narrow.id);

        const byPackages = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?sort=packages`)
            .set(authHeaders());
        expect(byPackages.status).toBe(200);
        expect(
            byPackages.body.vulnerabilities.map((v: { vulnId: string; packageCount: number }) => [
                v.vulnId,
                v.packageCount,
            ]),
        ).toEqual([
            ["CVE-2024-0010", 2],
            ["CVE-2024-0011", 1],
        ]);

        const byCvss = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?sort=cvss&order=asc`)
            .set(authHeaders());
        expect(byCvss.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual([
            "CVE-2024-0010",
            "CVE-2024-0011",
        ]);
    });

    it("ranks exploited findings first, then by contribution — never severity first", async () => {
        const { lodashA, lodashB, reactA } = await seedTwoImages();

        // An idle critical: high CVSS, negligible EPSS, not on KEV.
        const idleCritical = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            epssScore: 0.01,
        });
        // A medium under active exploitation: on CISA KEV.
        const kevMedium = await advisory({
            vulnId: "CVE-2024-0002",
            severityLevel: "medium",
            cvssScore: 5.3,
            epssScore: 0.02,
            kevListedAt: new Date("2024-01-10T00:00:00Z"),
        });
        // No CVSS at all, but on KEV — the case a severity-first sort buries last.
        const kevUnscored = await advisory({
            vulnId: "CVE-2024-0003",
            severityLevel: "unknown",
            cvssScore: null,
            kevListedAt: new Date("2024-02-01T00:00:00Z"),
        });
        // Likely exploited by EPSS alone, no KEV listing.
        const epssLow = await advisory({
            vulnId: "CVE-2024-0004",
            severityLevel: "low",
            cvssScore: 3.1,
            epssScore: 0.4,
        });
        await finding(lodashA.id, idleCritical.id);
        await finding(lodashB.id, kevMedium.id);
        await finding(reactA.id, kevUnscored.id);
        await finding(reactA.id, epssLow.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        const rows = response.body.vulnerabilities as { vulnId: string; exploited: boolean; severity: string | null }[];
        // Every exploited row precedes every non-exploited one; among the
        // exploited, the larger contribution (KEV pins exploitation at 1.0,
        // so CVSS decides) comes first.
        expect(rows.map((r) => r.exploited)).toEqual([true, true, true, false]);
        expect(rows.at(-1)?.vulnId).toBe("CVE-2024-0001");
        expect(rows[0]?.vulnId).toBe("CVE-2024-0002");
        // The unscored KEV finding is above the idle critical, and reports
        // no severity rather than the mirror's word for it.
        const unscoredIndex = rows.findIndex((r) => r.vulnId === "CVE-2024-0003");
        expect(unscoredIndex).toBeLessThan(3);
        expect(rows[unscoredIndex]?.severity).toBeNull();
        // The unscored count rides on the page, under the search alone.
        expect(response.body.unscoredFindings).toBe(1);

        // `severity=unscored` is a filter value of its own.
        const unscoredOnly = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?severity=unscored`)
            .set(authHeaders());
        expect(unscoredOnly.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual(["CVE-2024-0003"]);
        expect(unscoredOnly.body.totalFindings).toBe(1);
        // And the count still reports under another band's filter.
        const criticalOnly = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?severity=critical`)
            .set(authHeaders());
        expect(criticalOnly.body.totalFindings).toBe(1);
        expect(criticalOnly.body.unscoredFindings).toBe(1);
    });

    it("carries the KEV facts and the publication date on the row", async () => {
        const { lodashA } = await seedTwoImages();

        const kev = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            kevListedAt: new Date("2024-01-10T00:00:00Z"),
            kevDueDate: new Date("2024-01-31T00:00:00Z"),
            kevRansomware: "Known",
            publishedAt: new Date("2024-01-02T00:00:00Z"),
        });
        await finding(lodashA.id, kev.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        const [row] = response.body.vulnerabilities;
        expect(row.kevListedAt).toContain("2024-01-10");
        expect(row.kevDueDate).toContain("2024-01-31");
        expect(row.kevRansomware).toBe("Known");
        expect(row.publishedAt).toContain("2024-01-02");
    });

    it("collapses aliased advisories to one row, exactly as every other surface", async () => {
        const { lodashA } = await seedTwoImages();

        const cve = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high", cvssScore: 8.1 });
        const ghsa = await advisory({
            vulnId: "GHSA-aaaa-bbbb-cccc",
            severityLevel: "high",
            cvssScore: 8.1,
            aliases: ["CVE-2024-0001"],
        });
        await finding(lodashA.id, cve.id);
        await finding(lodashA.id, ghsa.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.total).toBe(1);
        expect(response.body.totalFindings).toBe(1);
        expect(response.body.vulnerabilities[0].vulnId).toBe("CVE-2024-0001");
    });

    it("names the advisory that matched and the record a borrowed severity came from", async () => {
        const { lodashA, reactA } = await seedTwoImages();

        // The Go vuln DB case: the ecosystem advisory matched, the CVE record
        // (never matched — it has no ranges) lent it its 7.5.
        await advisory({ vulnId: "CVE-2026-33814", severityLevel: "high", cvssScore: 7.5 });
        const go = await advisory({
            vulnId: "GO-2026-4918",
            severityLevel: "high",
            cvssScore: 7.5,
            severitySource: "CVE-2026-33814",
            aliases: ["CVE-2026-33814"],
        });
        await finding(lodashA.id, go.id);
        // Matched as itself, scored on its own.
        const own = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "medium", cvssScore: 5.3 });
        await finding(reactA.id, own.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        const byId = Object.fromEntries(response.body.vulnerabilities.map((v: { vulnId: string }) => [v.vulnId, v]));
        expect(byId["CVE-2026-33814"]).toMatchObject({
            severity: "high",
            cvssScore: 7.5,
            matchedVia: ["GO-2026-4918"],
            severitySource: "CVE-2026-33814",
        });
        expect(byId["CVE-2024-0002"]).toMatchObject({ matchedVia: [], severitySource: null });

        const detail = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/detail?identity=CVE-2026-33814`)
            .set(authHeaders());
        expect(detail.status).toBe(200);
        expect(detail.body.advisories).toMatchObject([
            { vulnId: "GO-2026-4918", cvssScore: 7.5, severitySource: "CVE-2026-33814" },
        ]);
    });

    it("does not count an unconfirmed match as a vulnerability", async () => {
        const { lodashA } = await seedTwoImages();

        const vuln = await advisory({ vulnId: "CVE-2024-0003", severityLevel: "critical" });
        await finding(lodashA.id, vuln.id, { confidence: "unconfirmed" });

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ vulnerabilities: [], total: 0, totalFindings: 0 });
    });

    it("filters by severity per finding, comma-joined, unknown values degrading", async () => {
        const { lodashA, reactA } = await seedTwoImages();

        const critical = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "critical", cvssScore: 9.8 });
        const low = await advisory({ vulnId: "CVE-2024-0004", severityLevel: "low", cvssScore: 2.0 });
        await finding(lodashA.id, critical.id);
        await finding(reactA.id, low.id);

        const onlyCritical = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?severity=critical`)
            .set(authHeaders());
        expect(onlyCritical.status).toBe(200);
        expect(onlyCritical.body.total).toBe(1);
        expect(onlyCritical.body.totalFindings).toBe(1);
        expect(onlyCritical.body.vulnerabilities[0].vulnId).toBe("CVE-2024-0001");

        const both = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?severity=critical,low`)
            .set(authHeaders());
        expect(both.body.total).toBe(2);

        // A hand-edited value filters nothing rather than erroring.
        const bogus = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?severity=bogus`)
            .set(authHeaders());
        expect(bogus.status).toBe(200);
        expect(bogus.body.total).toBe(2);
    });

    it("searches by advisory id and by package name, server-side", async () => {
        const { lodashA, reactA } = await seedTwoImages();

        const one = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
        const two = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high" });
        await finding(lodashA.id, one.id);
        await finding(reactA.id, two.id);

        const byId = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?search=2024-0001`)
            .set(authHeaders());
        expect(byId.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual(["CVE-2024-0001"]);

        const byPackage = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities?search=react`)
            .set(authHeaders());
        expect(byPackage.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual(["CVE-2024-0002"]);
    });

    it("never lists another cluster's findings of the same advisory", async () => {
        const db = getTestDb();
        const { lodashA } = await seedTwoImages();

        const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
        await finding(lodashA.id, vuln.id);

        // Same org, different cluster carrying the same advisory (ADR 0006).
        const otherCluster = await createCluster(db, testData.org.id);
        const other = await seedRunningImage(db, testData.org.id, otherCluster.id, {
            digest: "sha256:" + "c".repeat(64),
            workloadName: "elsewhere",
        });
        const otherSbom = await createSbom(db, { imageId: other.image.id });
        const otherLodash = await component(otherSbom.id, "lodash", "4.17.21");
        await finding(otherLodash.id, vuln.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.vulnerabilities[0]).toMatchObject({
            findingCount: 1,
            imageCount: 1,
            workloadCount: 1,
        });
    });

    it("404s for a cluster the org does not own", async () => {
        const db = getTestDb();
        const stranger = await createOrgWithOwner(db);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(
                createInternalHeaders({
                    id: stranger.user.id,
                    email: stranger.user.email,
                    orgId: stranger.org.id,
                    orgName: stranger.org.name,
                    orgSlug: stranger.org.slug,
                }),
            );

        expect(response.status).toBe(404);
    });

    it("returns an empty page, not 404, for a cluster with no scans", async () => {
        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
            .set(authHeaders());

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

    describe("occurrences (the count drill-down)", () => {
        it("lists the images and workloads one advisory affects, with links' ids", async () => {
            const seeded = await seedTwoImages();

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images.map((i: { id: string }) => i.id).sort()).toEqual(
                [seeded.imageA.id, seeded.imageB.id].sort(),
            );
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName).sort()).toEqual([
                "api",
                "worker",
            ]);
            for (const workload of response.body.workloads) {
                expect(workload.containerId).toBeTruthy();
                expect(workload.namespaceName).toBe("default");
            }
        });

        it("lists every running container, a sidecar on an affected image included, once each", async () => {
            const seeded = await seedTwoImages();
            // A second container of "api" on image A: one workload, two containers.
            await createWorkloadContainer(getTestDb(), testData.org.id, seeded.workloadA.id, seeded.imageA.id, {
                name: "sidecar",
            });

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            // Two packages of image A carry it — its containers must still list once.
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.reactA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.workloads).toHaveLength(2);
            expect(
                response.body.containers.map((c: { workloadName: string; containerName: string; imageId: string }) => [
                    c.workloadName,
                    c.containerName,
                    c.imageId,
                ]),
            ).toEqual([
                ["api", "app", seeded.imageA.id],
                ["api", "sidecar", seeded.imageA.id],
                ["worker", "app", seeded.imageB.id],
            ]);
            // Deployed by tag, and not installed by Helm.
            expect(response.body.containers[2]).toMatchObject({ imageTag: "1.0.0", release: null });

            // The list row's count is the same set.
            const list = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities`)
                .set(authHeaders());
            expect(list.body.vulnerabilities[0].containerCount).toBe(3);
        });

        it("names the Helm release and chart that installed each container", async () => {
            const db = getTestDb();
            const seeded = await seedTwoImages();
            const release = await createHelmRelease(db, testData.org.id, testData.cluster.id, {
                name: "api-prod",
                chartName: "api-chart",
                chartVersion: "2.3.1",
            });
            await db
                .update(schema.workloads)
                .set({ releaseId: release.id })
                .where(eq(schema.workloads.id, seeded.workloadA.id));

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.containers).toHaveLength(1);
            expect(response.body.containers[0].release).toEqual({
                id: release.id,
                name: "api-prod",
                chartName: "api-chart",
                chartVersion: "2.3.1",
            });
        });

        it("says, per image, how many containers run it and which package versions carry the advisory", async () => {
            const seeded = await seedTwoImages();

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.reactA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            const byId = new Map<string, { containerCount: number; packages: { name: string; version: string }[] }>(
                response.body.images.map((i: { id: string }) => [i.id, i]),
            );
            expect(byId.get(seeded.imageA.id)!.containerCount).toBe(1);
            expect(
                byId
                    .get(seeded.imageA.id)!
                    .packages.map((p) => `${p.name}@${p.version}`)
                    .sort(),
            ).toEqual(["lodash@4.17.21", "react@18.0.0"]);
            expect(byId.get(seeded.imageB.id)!.packages).toEqual([
                expect.objectContaining({ name: "lodash", version: "4.17.21", location: null }),
            ]);
        });

        it("says where in the image each affected package was found", async () => {
            const db = getTestDb();
            const seeded = await seedTwoImages();
            await db.insert(schema.componentProperties).values([
                {
                    componentId: seeded.lodashA.id,
                    name: "syft:location:0:path",
                    value: "/app/node_modules/lodash/package.json",
                },
                // Another property of the same component must not add a row.
                { componentId: seeded.lodashA.id, name: "syft:package:type", value: "npm" },
            ]);

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images).toHaveLength(1);
            expect(response.body.images[0].packages).toEqual([
                expect.objectContaining({
                    name: "lodash",
                    version: "4.17.21",
                    purlType: "npm",
                    location: "/app/node_modules/lodash/package.json",
                }),
            ]);
        });

        it("narrows to the images one side controls with ?control=", async () => {
            const db = getTestDb();
            const seeded = await seedTwoImages();
            await db
                .update(schema.images)
                .set({ control: "third-party" })
                .where(eq(schema.images.id, seeded.imageB.id));

            const vuln = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            await finding(seeded.lodashA.id, vuln.id);
            await finding(seeded.lodashB.id, vuln.id);
            const mine = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high" });
            await finding(seeded.reactA.id, mine.id);

            const base = `/api/clusters/${testData.cluster.id}/vulnerabilities`;
            const thirdParty = await request(app).get(`${base}?control=third-party`).set(authHeaders());
            expect(thirdParty.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId)).toEqual(["CVE-2024-0001"]);
            expect(thirdParty.body.vulnerabilities[0].imageCount).toBe(1);

            const yours = await request(app).get(`${base}?control=yours`).set(authHeaders());
            expect(yours.body.vulnerabilities.map((v: { vulnId: string }) => v.vulnId).sort()).toEqual([
                "CVE-2024-0001",
                "CVE-2024-0002",
            ]);

            const occurrences = await request(app)
                .get(`${base}/occurrences?identity=CVE-2024-0001&control=third-party`)
                .set(authHeaders());
            expect(occurrences.body.images.map((i: { id: string }) => i.id)).toEqual([seeded.imageB.id]);
        });

        it("scopes to the identity — a sibling advisory's images do not list", async () => {
            const seeded = await seedTwoImages();

            const one = await advisory({ vulnId: "CVE-2024-0001", severityLevel: "high" });
            const two = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high" });
            await finding(seeded.lodashA.id, one.id);
            await finding(seeded.reactA.id, two.id);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0002`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.images.map((i: { id: string }) => i.id)).toEqual([seeded.imageA.id]);
            expect(response.body.workloads.map((w: { workloadName: string }) => w.workloadName)).toEqual(["api"]);

            const unknown = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-1999-9999`)
                .set(authHeaders());
            expect(unknown.body).toEqual({
                images: [],
                workloads: [],
                containers: [],
                tierCounts: { application: 0, base: 0, all: 0 },
            });
        });

        it("404s for a cluster the org does not own", async () => {
            const db = getTestDb();
            const stranger = await createOrgWithOwner(db);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences?identity=CVE-2024-0001`)
                .set(
                    createInternalHeaders({
                        id: stranger.user.id,
                        email: stranger.user.email,
                        orgId: stranger.org.id,
                        orgName: stranger.org.name,
                        orgSlug: stranger.org.slug,
                    }),
                );

            expect(response.status).toBe(404);
        });

        it("400s without an identity", async () => {
            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/occurrences`)
                .set(authHeaders());

            expect(response.status).toBe(400);
        });
    });

    describe("detail (the expand-row drill-down)", () => {
        it("returns every advisory record behind an aliased identity, worst CVSS first, with fixes", async () => {
            const { lodashA, lodashB } = await seedTwoImages();

            // The list collapses these to one CVE row; the detail must return
            // both records — the GHSA carries the summary the CVE stub lacks.
            const cve = await advisory({
                vulnId: "CVE-2024-0001",
                severityLevel: "high",
                cvssScore: 8.1,
            });
            const ghsa = await advisory({
                vulnId: "GHSA-aaaa-bbbb-cccc",
                severityLevel: "critical",
                cvssScore: 9.1,
                aliases: ["CVE-2024-0001"],
                summary: "Prototype pollution in lodash",
            });
            await finding(lodashA.id, cve.id);
            await finding(lodashA.id, ghsa.id, { fixedVersion: "4.17.22" });
            await finding(lodashB.id, ghsa.id, { fixedVersion: "4.17.22" });

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/detail?identity=CVE-2024-0001`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body.advisories).toHaveLength(2);
            const [first, second] = response.body.advisories;
            expect(first).toMatchObject({
                vulnId: "GHSA-aaaa-bbbb-cccc",
                severity: "critical",
                cvssScore: 9.1,
                summary: "Prototype pollution in lodash",
                aliases: ["CVE-2024-0001"],
                source: "osv",
            });
            expect(second).toMatchObject({
                vulnId: "CVE-2024-0001",
                severity: "high",
                cvssScore: 8.1,
                summary: null,
            });
            // One distinct (package, version) pair — not one row per image.
            expect(response.body.fixes).toEqual([{ packageName: "lodash", fixedVersion: "4.17.22" }]);
        });

        it("returns empty sets for an identity with no findings in this cluster", async () => {
            await seedTwoImages();

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/detail?identity=CVE-1999-9999`)
                .set(authHeaders());

            expect(response.status).toBe(200);
            expect(response.body).toEqual({
                advisories: [],
                fixes: [],
                tierCounts: { application: 0, base: 0, all: 0 },
            });
        });

        it("404s for a cluster the org does not own", async () => {
            const db = getTestDb();
            const stranger = await createOrgWithOwner(db);

            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/detail?identity=CVE-2024-0001`)
                .set(
                    createInternalHeaders({
                        id: stranger.user.id,
                        email: stranger.user.email,
                        orgId: stranger.org.id,
                        orgName: stranger.org.name,
                        orgSlug: stranger.org.slug,
                    }),
                );

            expect(response.status).toBe(404);
        });

        it("400s without an identity", async () => {
            const response = await request(app)
                .get(`/api/clusters/${testData.cluster.id}/vulnerabilities/detail`)
                .set(authHeaders());

            expect(response.status).toBe(400);
        });
    });
});
