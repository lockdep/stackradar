import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
// Schema only — importing src/db/index.js here would eagerly connect the
// app's client before the test container's DATABASE_URL is set.
import * as schema from "../../../src/db/schema/index.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createSbom,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";

/**
 * GET /api/clusters/:id/radar-score — the Radar Score tab.
 *
 * The contract under test: one row per scanned image of ONE cluster, largest
 * share first, where the rows' scores are the decomposition of the number the
 * Overview chart shows (`clusterRiskScores`) and each row's expand list adds
 * up to that row. Nothing from another cluster or org is ever visible.
 */
describe("cluster radar score tab", () => {
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
                    },
                ]),
            )
            .returning();
        return vuln!;
    }

    async function finding(componentId: string, vulnerabilityId: string) {
        await getTestDb().insert(schema.componentVulnerabilities).values({
            componentId,
            vulnerabilityId,
            matchedBy: "purl",
            matchType: "direct",
            matchConfidence: "exact",
        });
    }

    /**
     * Image A: a KEV critical (≈98) and an unscored high (≈8) on two
     * packages. Image B: the same unscored high once. A must rank first,
     * and the cluster total must be the fold of all three.
     */
    async function seedTwoImages() {
        const db = getTestDb();
        const { org, cluster } = testData;

        const a = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
            imageTag: "2.1.0",
        });
        // A second deployment of image A under another tag: the row lists
        // every tag the digest was asked for by, sorted, deduplicated.
        await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "api-canary",
            image: a.image,
            imageTag: "2.1.0-rc1",
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });
        // Digest-pinned: no tag at all, never an invented one.
        const b = await seedRunningImage(db, org.id, cluster.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
            imageTag: null,
        });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        const kev = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            kevListedAt: new Date("2024-01-10T00:00:00Z"),
        });
        const high = await advisory({ vulnId: "CVE-2024-0002", severityLevel: "high", cvssScore: 8.1 });

        await finding((await component(sbomA.id, "lodash", "4.17.21")).id, kev.id);
        await finding((await component(sbomA.id, "react", "18.0.0")).id, high.id);
        await finding((await component(sbomB.id, "react", "18.0.0")).id, high.id);

        return { imageA: a.image, imageB: b.image };
    }

    it("lists images largest share first, totalling the cluster's Radar Score", async () => {
        const { imageA, imageB } = await seedTwoImages();
        const { clusterRiskScores } = await import("../../../src/db/risk.js");
        const rollup = (await clusterRiskScores([testData.cluster.id])).get(testData.cluster.id)!;

        const response = await request(app).get(`/api/clusters/${testData.cluster.id}/radar-score`).set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.imageCount).toBe(2);
        expect(response.body.findingCount).toBe(3);
        // Non-zero first: agreeing on 0 would also pass with the fold broken.
        expect(rollup.score).toBeGreaterThan(0);
        expect(response.body.total).toBe(Math.round(rollup.score));

        const [first, second] = response.body.images;
        expect(first).toMatchObject({
            imageId: imageA.id,
            findingCount: 2,
            kevCount: 1,
            band: "critical",
            topFinding: { vulnId: "CVE-2024-0001" },
            tags: ["2.1.0", "2.1.0-rc1"],
            workloads: [
                { namespaceName: "default", workloadName: "api" },
                { namespaceName: "default", workloadName: "api-canary" },
            ],
        });
        expect(second).toMatchObject({
            imageId: imageB.id,
            findingCount: 1,
            kevCount: 0,
            topFinding: { vulnId: "CVE-2024-0002" },
            tags: [],
        });
        expect(first.score).toBeGreaterThan(second.score);
        expect(first.score + second.score).toBe(response.body.total);
    });

    it("expands an image into the findings that add up to its share", async () => {
        const { imageA } = await seedTwoImages();

        const list = await request(app).get(`/api/clusters/${testData.cluster.id}/radar-score`).set(authHeaders());
        const rowA = list.body.images.find((i: { imageId: string }) => i.imageId === imageA.id);

        const response = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/radar-score/findings`)
            .query({ imageId: imageA.id })
            .set(authHeaders());

        expect(response.status).toBe(200);
        const findings = response.body.findings as { vulnId: string; riskScore: number; packageName: string }[];
        expect(findings.map((f) => f.vulnId)).toEqual(["CVE-2024-0001", "CVE-2024-0002"]);
        expect(findings[0]).toMatchObject({
            packageName: "lodash",
            severity: "critical",
            cvssScore: 9.8,
            kevListedAt: "2024-01-10T00:00:00.000Z",
        });
        const sum = findings.reduce((acc, f) => acc + f.riskScore, 0);
        expect(Math.round(sum)).toBe(rowA.score);
    });

    it("never shows an image from another cluster, even one the org owns", async () => {
        const db = getTestDb();
        const { imageA } = await seedTwoImages();
        const other = await createCluster(db, testData.org.id, { name: "other-cluster" });
        const foreign = await seedRunningImage(db, testData.org.id, other.id, {
            workloadName: "foreign",
            digest: "sha256:" + "c".repeat(64),
        });
        const sbom = await createSbom(db, { imageId: foreign.image.id });
        const vuln = await advisory({ vulnId: "CVE-2024-0003", severityLevel: "critical", cvssScore: 9.9 });
        await finding((await component(sbom.id, "left-pad", "1.0.0")).id, vuln.id);

        const list = await request(app).get(`/api/clusters/${testData.cluster.id}/radar-score`).set(authHeaders());
        expect(list.body.images.map((i: { imageId: string }) => i.imageId)).not.toContain(foreign.image.id);
        expect(list.body.images.map((i: { imageId: string }) => i.imageId)).toContain(imageA.id);

        // The drill-down keeps the cluster scope on the query, not just on the route.
        const detail = await request(app)
            .get(`/api/clusters/${testData.cluster.id}/radar-score/findings`)
            .query({ imageId: foreign.image.id })
            .set(authHeaders());
        expect(detail.status).toBe(200);
        expect(detail.body.findings).toEqual([]);
    });
});
