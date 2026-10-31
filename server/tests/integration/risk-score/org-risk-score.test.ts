import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
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
 * GET /api/risk-score — the org-wide Risk Score breakdown.
 *
 * The cluster tab's contract (`clusters/cluster-risk-score.test.ts`) with
 * the scope widened to every cluster of the caller's org: one row per image
 * across all of them, each naming its cluster, the rows' scores summing to
 * the org's Risk Score (`orgRiskRollup`), the drill-down keeping the org
 * scope on the query, and nothing from another org ever visible.
 */
describe("org-wide risk score", () => {
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

    /**
     * Cluster A: image A with an idle critical (≈7) and a KEV medium (≈53).
     * Cluster B: image B with the same idle critical. A must rank first and
     * the org total must be the fold of all three.
     */
    async function seedTwoClusters() {
        const db = getTestDb();
        const { org, cluster: clusterA } = testData;
        const clusterB = await createCluster(db, org.id, { name: "cluster-b" });

        const a = await seedRunningImage(db, org.id, clusterA.id, {
            workloadName: "api",
            digest: "sha256:" + "a".repeat(64),
            imageTag: "2.1.0",
        });
        const b = await seedRunningImage(db, org.id, clusterB.id, {
            workloadName: "worker",
            digest: "sha256:" + "b".repeat(64),
            imageTag: "1.0.0",
        });
        const sbomA = await createSbom(db, { imageId: a.image.id });
        const sbomB = await createSbom(db, { imageId: b.image.id });

        const idleCritical = await advisory({
            vulnId: "CVE-2024-0001",
            severityLevel: "critical",
            cvssScore: 9.8,
            epssScore: 0.001,
        });
        const kevMedium = await advisory({
            vulnId: "CVE-2024-0002",
            severityLevel: "medium",
            cvssScore: 5.3,
            epssScore: 0.02,
            kevListedAt: new Date("2024-01-10T00:00:00Z"),
        });

        await finding((await component(sbomA.id, "lodash", "4.17.21")).id, idleCritical.id, "4.17.22");
        await finding((await component(sbomA.id, "react", "18.0.0")).id, kevMedium.id, "18.2.0");
        await finding((await component(sbomB.id, "lodash", "4.17.21")).id, idleCritical.id, "4.17.22");

        return { clusterA, clusterB, imageA: a.image, imageB: b.image };
    }

    it("lists images across clusters largest share first, naming each cluster, totalling the org's Risk Score", async () => {
        const { clusterA, clusterB, imageA, imageB } = await seedTwoClusters();
        const { orgRiskRollup } = await import("../../../src/db/risk.js");
        const rollup = await orgRiskRollup(testData.org.id);

        const response = await request(app).get("/api/risk-score").set(authHeaders());

        expect(response.status).toBe(200);
        expect(response.body.imageCount).toBe(2);
        expect(response.body.findingCount).toBe(3);
        expect(rollup.score).toBeGreaterThan(0);
        expect(response.body.total).toBe(Math.round(rollup.score));

        const [first, second] = response.body.images;
        expect(first).toMatchObject({
            imageId: imageA.id,
            clusterId: clusterA.id,
            clusterName: clusterA.name,
            findingCount: 2,
            kevCount: 1,
            topFinding: { vulnId: "CVE-2024-0002" },
            tags: ["2.1.0"],
        });
        expect(second).toMatchObject({
            imageId: imageB.id,
            clusterId: clusterB.id,
            clusterName: "cluster-b",
            findingCount: 1,
            kevCount: 0,
        });
        expect(first.score).toBeGreaterThan(second.score);
        expect(first.score + second.score).toBe(response.body.total);
    });

    it("expands an image from any cluster into its findings, and refuses another org's image", async () => {
        const db = getTestDb();
        const { imageB } = await seedTwoClusters();

        const response = await request(app)
            .get("/api/risk-score/findings")
            .query({ imageId: imageB.id })
            .set(authHeaders());
        expect(response.status).toBe(200);
        expect(response.body.findings.map((f: { vulnId: string }) => f.vulnId)).toEqual(["CVE-2024-0001"]);

        // Another org's image: the scope is on the query, so nothing lists.
        const stranger = await createOrgWithOwner(db);
        const strangerCluster = await createCluster(db, stranger.org.id);
        const foreign = await seedRunningImage(db, stranger.org.id, strangerCluster.id, {
            workloadName: "foreign",
            digest: "sha256:" + "c".repeat(64),
        });
        const sbom = await createSbom(db, { imageId: foreign.image.id });
        const vuln = await advisory({ vulnId: "CVE-2024-0003", severityLevel: "critical", cvssScore: 9.9 });
        await finding((await component(sbom.id, "left-pad", "1.0.0")).id, vuln.id);

        const list = await request(app).get("/api/risk-score").set(authHeaders());
        expect(list.body.images.map((i: { imageId: string }) => i.imageId)).not.toContain(foreign.image.id);

        const detail = await request(app)
            .get("/api/risk-score/findings")
            .query({ imageId: foreign.image.id })
            .set(authHeaders());
        expect(detail.status).toBe(200);
        expect(detail.body.findings).toEqual([]);
    });

    it("returns an empty page for an org with no scans", async () => {
        const response = await request(app).get("/api/risk-score").set(authHeaders());
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ images: [], total: 0, imageCount: 0, findingCount: 0 });
    });
});
