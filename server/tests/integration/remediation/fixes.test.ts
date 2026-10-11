/**
 * GET /api/remediation/fixes — the Fixes page.
 *
 * The contract: one ranked, read-only list of every move the product can
 * recommend across the org (measured first), totals that add up the
 * measured ones, and a remainder naming every image with findings that has
 * no move — each with the scan's stated reason, never silence. Every image
 * with findings appears exactly once, on one side or the other.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createImage,
    createSbom,
    createHelmRelease,
    createNamespace,
    createWorkload,
    createWorkloadContainer,
    createOrgWithOwner,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let app: Awaited<ReturnType<typeof getTestApp>>;
let scenario: SeedTestScenarioResult;

function authHeaders() {
    return createInternalHeaders({
        id: scenario.user.id,
        email: scenario.user.email,
        orgId: scenario.org.id,
    });
}

async function advisory(vulnId: string, opts: { cvss?: number; kev?: boolean } = {}) {
    const db = getTestDb();
    const cvss = opts.cvss ?? 7.5;
    const [row] = await db
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId,
                    source: "osv",
                    cvssScore: cvss,
                    severityLevel: cvss >= 9 ? "critical" : cvss >= 7 ? "high" : "medium",
                    kevListedAt: opts.kev ? new Date("2021-12-10") : null,
                    aliases: [],
                },
            ]),
        )
        .returning();
    return row!;
}

async function finding(
    sbomId: string,
    packageName: string,
    vulnerabilityId: string,
    opts: { fixedVersion?: string | null; matchedEcosystem?: string | null } = {},
) {
    const db = getTestDb();
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId,
            name: packageName,
            version: "1.0.0",
            purl: `pkg:apk/alpine/${packageName}@1.0.0`,
            type: "library",
            isDirect: true,
        })
        .returning();
    await db.insert(schema.componentVulnerabilities).values({
        componentId: component!.id,
        vulnerabilityId,
        matchedBy: "purl",
        matchType: "direct",
        matchConfidence: "exact",
        fixedVersion: opts.fixedVersion ?? null,
        matchedEcosystem: opts.matchedEcosystem ?? null,
    });
}

type FixRow = {
    id: string;
    kind: string;
    measured: boolean;
    target: { type: string; imageId?: string; releaseId?: string };
};
type NoRecRow = { imageId: string; reason: string; findings: number; kev: number };

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("GET /api/remediation/fixes", () => {
    it("lists measured moves first with what they clear, and names every image without a move", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;

        // A measured tag move: two scanned digests of one repository, the
        // older running with a KEV critical the newer does not carry.
        const nginxOld = await createImage(db, org.id, cluster.id, {
            repository: "library/nginx",
            digest: "sha256:" + "1".repeat(64),
        });
        const nginxNew = await createImage(db, org.id, cluster.id, {
            repository: "library/nginx",
            digest: "sha256:" + "2".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: nginxOld,
            workloadName: "web",
            namespace: "edge",
            imageTag: "1.25.0",
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: nginxOld,
            workloadName: "proxy",
            namespace: "edge",
            imageTag: "1.25.0",
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: nginxNew,
            workloadName: "web-canary",
            namespace: "edge",
            imageTag: "1.25.6",
        });
        const oldSbom = await createSbom(db, { imageId: nginxOld.id });
        await createSbom(db, { imageId: nginxNew.id });
        await finding(oldSbom.id, "libssl", (await advisory("CVE-2024-0001", { cvss: 9.8, kev: true })).id, {
            fixedVersion: "3.0.1",
        });
        await finding(oldSbom.id, "zlib", (await advisory("CVE-2024-0002", { cvss: 5 })).id, {
            fixedVersion: "1.3.1",
        });

        // No move: only one scanned digest of this repository in the org.
        const lonely = await createImage(db, org.id, cluster.id, {
            repository: "acme/lonely",
            digest: "sha256:" + "3".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: lonely,
            workloadName: "lonely",
            namespace: "default",
            imageTag: "2.0.0",
        });
        const lonelySbom = await createSbom(db, { imageId: lonely.id });
        await finding(lonelySbom.id, "libfoo", (await advisory("CVE-2024-0003", { cvss: 8 })).id, {
            fixedVersion: "2.0.0",
        });

        // No move: every finding is stranded on an EOL release line.
        const eol = await createImage(db, org.id, cluster.id, {
            repository: "acme/legacy",
            digest: "sha256:" + "4".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: eol,
            workloadName: "legacy",
            namespace: "default",
            imageTag: "3.16",
        });
        const eolSbom = await createSbom(db, { imageId: eol.id });
        await finding(eolSbom.id, "musl", (await advisory("CVE-2024-0004", { cvss: 7 })).id, {
            fixedVersion: null,
            matchedEcosystem: "Alpine:v3.16",
        });

        // Not a row anywhere: scanned and clean.
        const clean = await createImage(db, org.id, cluster.id, {
            repository: "acme/clean",
            digest: "sha256:" + "5".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: clean,
            workloadName: "clean",
            namespace: "default",
            imageTag: "1.0.0",
        });
        await createSbom(db, { imageId: clean.id });

        const res = await request(app).get("/api/remediation/fixes").set(authHeaders());
        expect(res.status).toBe(200);

        const fixes = res.body.fixes as FixRow[];
        expect(fixes).toHaveLength(1);
        expect(fixes[0]).toMatchObject({
            kind: "image",
            measured: true,
            subject: "library/nginx",
            from: "1.25.0",
            to: "1.25.6",
            bump: "patch",
            cluster: { id: cluster.id },
            cleared: { findings: 2, kev: 1, high: 1, introduced: 0 },
            workloads: 2,
            images: 1,
            delivery: "kubectl set image",
            target: { type: "image", imageId: nginxOld.id },
        });
        expect(fixes[0]).toHaveProperty("riskRemoved");
        expect((fixes[0] as unknown as { riskRemoved: number }).riskRemoved).toBeGreaterThan(0);

        expect(res.body.totals).toEqual({ upgrades: 1, findingsCleared: 2, kevCleared: 1 });

        const remainder = res.body.noRecommendation as NoRecRow[];
        expect(remainder.map((r) => r.imageId).sort()).toEqual([lonely.id, eol.id].sort());
        expect(remainder.find((r) => r.imageId === lonely.id)).toMatchObject({
            reason: "no-candidates",
            findings: 1,
            kev: 0,
            subject: "acme/lonely",
            currentTag: "2.0.0",
        });
        expect(remainder.find((r) => r.imageId === eol.id)).toMatchObject({
            reason: "eol",
            findings: 1,
            eolLines: [{ releaseLine: expect.any(String) }],
        });
        // The moved image and the clean one are on neither list twice.
        expect(remainder.some((r) => r.imageId === nginxOld.id)).toBe(false);
        expect(remainder.some((r) => r.imageId === clean.id)).toBe(false);
    });

    it("carries an unmeasured chart bump below measured moves, claiming only an upper bound, and keeps its images in the remainder", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;

        const prodRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "app-prod",
            namespace: "prod",
            chartName: "app",
            chartVersion: "1.0.0",
            repoUrl: "https://charts.example.com",
        });
        const devRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "app-dev",
            namespace: "dev",
            chartName: "app",
            chartVersion: "1.1.0",
            repoUrl: "https://charts.example.com",
        });
        const appOld = await createImage(db, org.id, cluster.id, {
            repository: "acme/app",
            digest: "sha256:" + "7".repeat(64),
        });
        const appNew = await createImage(db, org.id, cluster.id, {
            repository: "acme/app",
            digest: "sha256:" + "8".repeat(64),
        });
        const nsProd = await createNamespace(db, org.id, cluster.id, { name: "prod" });
        const w1 = await createWorkload(db, org.id, nsProd.id, { name: "app", releaseId: prodRelease.id });
        await createWorkloadContainer(db, org.id, w1.id, appOld.id, { name: "app" });
        const nsDev = await createNamespace(db, org.id, cluster.id, { name: "dev" });
        const w2 = await createWorkload(db, org.id, nsDev.id, { name: "app", releaseId: devRelease.id });
        await createWorkloadContainer(db, org.id, w2.id, appNew.id, { name: "app" });

        const prodSbom = await createSbom(db, { imageId: appOld.id });
        // No SBOM for appNew — the sibling is unmeasured.
        await finding(prodSbom.id, "libfoo", (await advisory("CVE-2024-5000", { cvss: 8 })).id, {
            fixedVersion: "2.0.0",
        });

        // A measured move so there is something to rank above it.
        const tinyOld = await createImage(db, org.id, cluster.id, {
            repository: "library/nginx",
            digest: "sha256:" + "1".repeat(64),
        });
        const tinyNew = await createImage(db, org.id, cluster.id, {
            repository: "library/nginx",
            digest: "sha256:" + "2".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: tinyOld,
            workloadName: "web",
            namespace: "edge",
            imageTag: "1.25.0",
        });
        await seedRunningImage(db, org.id, cluster.id, {
            image: tinyNew,
            workloadName: "web-canary",
            namespace: "edge",
            imageTag: "1.25.6",
        });
        const tinySbom = await createSbom(db, { imageId: tinyOld.id });
        await createSbom(db, { imageId: tinyNew.id });
        await finding(tinySbom.id, "zlib", (await advisory("CVE-2024-6000", { cvss: 4 })).id, {
            fixedVersion: "1.3.1",
        });

        const res = await request(app).get("/api/remediation/fixes").set(authHeaders());
        expect(res.status).toBe(200);

        const fixes = res.body.fixes as FixRow[];
        expect(fixes.map((f) => f.measured)).toEqual([true, false]);
        expect(fixes[1]).toMatchObject({
            kind: "chart",
            measured: false,
            subject: "app",
            release: { name: "app-prod", namespace: "prod" },
            from: "1.0.0",
            to: "1.1.0",
            cleared: null,
            riskRemoved: null,
            upperBound: { findings: 1 },
            workloads: 1,
            images: 1,
            target: { type: "release", releaseId: prodRelease.id },
        });
        expect((fixes[1] as unknown as { upperBound: { risk: number } }).upperBound.risk).toBeGreaterThan(0);

        // Unmeasured claims nothing about its images, so the totals count
        // only the measured move and the image stays in the remainder.
        expect(res.body.totals).toEqual({ upgrades: 1, findingsCleared: 1, kevCleared: 0 });
        const remainder = res.body.noRecommendation as NoRecRow[];
        expect(remainder.map((r) => r.imageId)).toEqual([appOld.id]);
        expect(remainder[0]!.reason).toBe("no-candidates");
    });

    it("sees nothing from another org", async () => {
        const db = getTestDb();
        const other = await createOrgWithOwner(db);
        const otherCluster = await createCluster(db, other.org.id, { name: "theirs" });
        const image = await createImage(db, other.org.id, otherCluster.id, {
            repository: "acme/secret",
            digest: "sha256:" + "9".repeat(64),
        });
        await seedRunningImage(db, other.org.id, otherCluster.id, {
            image,
            workloadName: "secret",
            namespace: "default",
            imageTag: "1.0.0",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await finding(sbom.id, "libbar", (await advisory("CVE-2024-9000", { cvss: 9 })).id, {
            fixedVersion: "1.1.0",
        });

        const res = await request(app).get("/api/remediation/fixes").set(authHeaders());
        expect(res.status).toBe(200);
        expect(res.body.fixes).toEqual([]);
        expect(res.body.noRecommendation).toEqual([]);
        expect(res.body.totals).toEqual({ upgrades: 0, findingsCleared: 0, kevCleared: 0 });
    });
});
