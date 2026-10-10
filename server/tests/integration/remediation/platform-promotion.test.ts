/**
 * Promotion to measured via platform-rendered candidates —
 * measuring-candidate-charts.md phases 1 and 3.
 *
 * The headline acceptance criterion: an org with a single cluster running a
 * chart, **no sibling release anywhere**, sees a measured chart-upgrade
 * suggestion for the candidate version — image moves, resolved/introduced
 * counts, risk delta. And its guard rails: a sibling measurement is preferred
 * when both exist, a failed render changes nothing, a credentialed repo never
 * crosses the boundary, and platform findings never count in any tenant's
 * numbers.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { getTestApp, createInternalHeaders } from "../../setup/test-app.js";
import {
    seedTestScenario,
    createImage,
    createSbom,
    createHelmRelease,
    createNamespace,
    createWorkload,
    createWorkloadContainer,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

const REPO_URL = "https://charts.example.com";
const TENANT_DIGEST = "sha256:" + "a".repeat(64);
const CANDIDATE_DIGEST = "sha256:" + "b".repeat(64);
const SIDECAR_DIGEST = "sha256:" + "c".repeat(64);

let app: Awaited<ReturnType<typeof getTestApp>>;

async function recommendation() {
    return import("../../../src/services/upgrade-recommendation.service.js");
}

async function advisory(
    vulnId: string,
    opts: { cvss: number; epss?: number; kev?: boolean } = { cvss: 7.5 }
) {
    const db = getTestDb();
    const [row] = await db
        .insert(schema.vulnerabilities)
        .values(withFindingIdentity([{
            vulnId,
            source: "osv",
            cvssScore: opts.cvss,
            severityLevel: opts.cvss >= 9 ? "critical" : opts.cvss >= 7 ? "high" : "medium",
            epssScore: opts.epss ?? null,
            kevListedAt: opts.kev ? new Date("2021-12-10") : null,
            aliases: [],
        }]))
        .returning();
    return row!;
}

async function finding(
    sbomId: string,
    packageName: string,
    vulnerabilityId: string,
    opts: { version?: string; purl?: string; fixedVersion?: string | null } = {}
) {
    const db = getTestDb();
    const version = opts.version ?? "1.0.0";
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId,
            name: packageName,
            version,
            purl: opts.purl ?? `pkg:deb/debian/${packageName}@${version}`,
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
    });
}

/**
 * The single-cluster customer: one release of `app` 1.0.0, its main image
 * scanned and carrying three findings (one KEV), plus an unscanned sidecar
 * the default render will not produce.
 */
async function seedLoneTenantRelease(scenario: SeedTestScenarioResult) {
    const db = getTestDb();
    const { org, cluster } = scenario;

    const release = await createHelmRelease(db, org.id, cluster.id, {
        name: "app",
        namespace: "prod",
        chartName: "app",
        chartVersion: "1.0.0",
        appVersion: "2.51.0",
        repoUrl: REPO_URL,
    });
    const ns = await createNamespace(db, org.id, cluster.id, { name: "prod" });
    const workload = await createWorkload(db, org.id, ns.id, { name: "app", releaseId: release.id });

    const mainImage = await createImage(db, org.id, cluster.id, {
        registry: "quay.io",
        repository: "acme/app",
        digest: TENANT_DIGEST,
    });
    await createWorkloadContainer(db, org.id, workload.id, mainImage.id, {
        name: "app",
        imageTag: "1.9.0",
    });

    const sidecarImage = await createImage(db, org.id, cluster.id, {
        registry: "quay.io",
        repository: "acme/sidecar",
        digest: SIDECAR_DIGEST,
    });
    await createWorkloadContainer(db, org.id, workload.id, sidecarImage.id, { name: "sidecar" });

    const sbom = await createSbom(db, { imageId: mainImage.id });
    const kev = await advisory("CVE-2021-44228", { cvss: 10, epss: 0.97, kev: true });
    const high = await advisory("CVE-2024-1000", { cvss: 8.1 });
    const persists = await advisory("CVE-2024-2000", { cvss: 6.5 });
    await finding(sbom.id, "log4j", kev.id);
    await finding(sbom.id, "openssl", high.id);
    await finding(sbom.id, "zlib", persists.id);

    return { release, mainImage, sidecarImage, advisories: { kev, high, persists } };
}

/** The platform side: a rendered 1.1.0 whose main-image digest is scanned. */
async function seedPlatformCandidate(opts: { persistsVulnId: string }) {
    const db = getTestDb();
    const { ensurePlatform } = await import("../../../src/services/platform.service.js");
    const platform = await ensurePlatform();

    await db.insert(schema.chartRenders).values({
        repoUrl: REPO_URL,
        chartName: "app",
        chartVersion: "1.1.0",
        status: "rendered",
        helmVersion: "v3.16.4",
        renderedAt: new Date(),
    });
    await db.insert(schema.chartImageObservations).values([
        {
            repoUrl: REPO_URL,
            chartName: "app",
            chartVersion: "1.1.0",
            imageRef: "quay.io/acme/app:2.0.0",
            registry: "quay.io",
            repository: "acme/app",
            tag: "2.0.0",
            digest: CANDIDATE_DIGEST,
        },
        {
            // Rendered but run by nobody in the tenant — must pair with
            // nothing and drop out, not become a claim.
            repoUrl: REPO_URL,
            chartName: "app",
            chartVersion: "1.1.0",
            imageRef: "quay.io/acme/extra:1.0",
            registry: "quay.io",
            repository: "acme/extra",
            tag: "1.0",
            digest: "sha256:" + "e".repeat(64),
        },
    ]);

    const platformImage = await createImage(db, platform.orgId, platform.clusterId, {
        registry: "quay.io",
        repository: "acme/app",
        digest: CANDIDATE_DIGEST,
    });
    const platformSbom = await createSbom(db, { imageId: platformImage.id });
    // The candidate still carries the survivor — the bump is not the whole fix.
    await finding(platformSbom.id, "zlib", opts.persistsVulnId);

    return { platform, platformImage };
}

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
});

describe("platform-render promotion (measuring-candidate-charts.md phase 3)", () => {
    it("promotes a lone release to a measured suggestion from platform-rendered observations", async () => {
        const scenario = await seedTestScenario(getTestDb());
        const { release, mainImage, advisories } = await seedLoneTenantRelease(scenario);
        const { platformImage } = await seedPlatformCandidate({
            persistsVulnId: advisories.persists.id,
        });

        const { recommendForRelease } = await recommendation();
        const result = await recommendForRelease(scenario.org.id, release.id);

        expect(result.availability).toBe("available");
        expect(result.evidence).toBe("platform-render");
        expect(result.target).toMatchObject({
            releaseId: null,
            chartVersion: "1.1.0",
            cluster: null,
            namespace: null,
        });
        expect(result.bump).toBe("minor");

        expect(result.imageMoves).toHaveLength(1);
        const move = result.imageMoves[0]!;
        expect(move.fromImageId).toBe(mainImage.id);
        expect(move.toImageId).toBe(platformImage.id);
        expect(move.toDigest).toBe(CANDIDATE_DIGEST);
        expect(move.summary.resolved).toBe(2);
        expect(move.summary.resolvedKev).toBe(1);
        expect(move.summary.unchanged).toBe(1);
        expect(move.summary.riskChange).toBeLessThan(0);

        // The unscanned sidecar the render does not produce is a stated gap.
        expect(result.unmeasuredImages).toBe(1);
    });

    it("prefers a sibling measurement whenever one exists", async () => {
        const db = getTestDb();
        const scenario = await seedTestScenario(db);
        const { release } = await seedLoneTenantRelease(scenario);
        const persists = (await db.select().from(schema.vulnerabilities)).find(
            (v) => v.vulnId === "CVE-2024-2000"
        )!;
        await seedPlatformCandidate({ persistsVulnId: persists.id });

        // A sibling appears at the same candidate version, scanned.
        const sibling = await createHelmRelease(db, scenario.org.id, scenario.cluster.id, {
            name: "app-staging",
            namespace: "staging",
            chartName: "app",
            chartVersion: "1.1.0",
            repoUrl: REPO_URL,
        });
        const ns = await createNamespace(db, scenario.org.id, scenario.cluster.id, {
            name: "staging",
        });
        const workload = await createWorkload(db, scenario.org.id, ns.id, {
            name: "app",
            releaseId: sibling.id,
        });
        const siblingImage = await createImage(db, scenario.org.id, scenario.cluster.id, {
            registry: "quay.io",
            repository: "acme/app",
            digest: "sha256:" + "d".repeat(64),
        });
        await createWorkloadContainer(db, scenario.org.id, workload.id, siblingImage.id, {
            name: "app",
        });
        await createSbom(db, { imageId: siblingImage.id });

        const { recommendForRelease } = await recommendation();
        const result = await recommendForRelease(scenario.org.id, release.id);

        expect(result.availability).toBe("available");
        expect(result.evidence).toBe("sibling-release");
        expect(result.target?.releaseId).toBe(sibling.id);
    });

    it("leaves a release exactly where it was when the render failed", async () => {
        const db = getTestDb();
        const scenario = await seedTestScenario(db);
        const { release } = await seedLoneTenantRelease(scenario);

        await db.insert(schema.chartRenders).values({
            repoUrl: REPO_URL,
            chartName: "app",
            chartVersion: "1.1.0",
            status: "render_failed",
            failureReason: "rendered output exceeded the ceiling",
            renderedAt: new Date(),
        });

        const { recommendForRelease } = await recommendation();
        const result = await recommendForRelease(scenario.org.id, release.id);

        expect(result.availability).toBe("no-candidates");
        expect(result.evidence).toBeNull();
        expect(result.imageMoves).toEqual([]);
    });

    it("never crosses the boundary via a repository the org reads with credentials", async () => {
        const db = getTestDb();
        const scenario = await seedTestScenario(db);
        const { release } = await seedLoneTenantRelease(scenario);
        const persists = (await db.select().from(schema.vulnerabilities)).find(
            (v) => v.vulnId === "CVE-2024-2000"
        )!;
        await seedPlatformCandidate({ persistsVulnId: persists.id });

        await db.insert(schema.chartRepositories).values({
            orgId: scenario.org.id,
            url: REPO_URL,
            source: "manual",
            enabled: true,
            username: "svc",
            password: "secret",
        });

        const { recommendForRelease } = await recommendation();
        const result = await recommendForRelease(scenario.org.id, release.id);

        expect(result.availability).toBe("no-candidates");
        expect(result.evidence).toBeNull();
    });

    it("keeps platform findings out of every tenant count", async () => {
        const db = getTestDb();
        const scenario = await seedTestScenario(db);
        const { release } = await seedLoneTenantRelease(scenario);
        const persists = (await db.select().from(schema.vulnerabilities)).find(
            (v) => v.vulnId === "CVE-2024-2000"
        )!;
        const { platformImage } = await seedPlatformCandidate({ persistsVulnId: persists.id });

        const res = await request(app)
            .get("/api/remediation/rollup")
            .set(
                createInternalHeaders({
                    id: scenario.user.id,
                    email: scenario.user.email,
                    orgId: scenario.org.id,
                })
            );
        expect(res.status).toBe(200);

        // The tenant's three findings, and not one more: the platform image's
        // finding on the same advisory never inflates the tenant's numbers.
        expect(res.body.totals.findings.total).toBe(3);
        const rowImageIds = res.body.rows.map((r: { image: { id: string } }) => r.image.id);
        expect(rowImageIds).not.toContain(platformImage.id);

        // And yet the measured suggestion built *from* those platform rows is
        // present — the candidate path is the one legitimate crossing.
        const chart = res.body.suggestions.find(
            (s: { type: string }) => s.type === "chart-upgrade"
        );
        expect(chart).toMatchObject({
            measured: true,
            evidence: "platform-render",
            release: { id: release.id },
            target: { releaseId: null, chartVersion: "1.1.0" },
        });
    });
});

describe("the sharpened unmeasured card (phase 1)", () => {
    it("shows the app-version move and the tightened bound", async () => {
        const db = getTestDb();
        const scenario = await seedTestScenario(db);
        const { org, cluster } = scenario;

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "prom",
            namespace: "monitoring",
            chartName: "prometheus",
            chartVersion: "58.7.0",
            appVersion: "2.51.0",
            repoUrl: REPO_URL,
        });
        const ns = await createNamespace(db, org.id, cluster.id, { name: "monitoring" });
        const workload = await createWorkload(db, org.id, ns.id, {
            name: "prometheus",
            releaseId: release.id,
        });
        const image = await createImage(db, org.id, cluster.id, {
            registry: "quay.io",
            repository: "prometheus/prometheus",
            digest: "sha256:" + "f".repeat(64),
        });
        await createWorkloadContainer(db, org.id, workload.id, image.id, { name: "prometheus" });

        const sbom = await createSbom(db, { imageId: image.id });
        const onApp = await advisory("CVE-2024-5000", { cvss: 8.0 });
        const onLib = await advisory("CVE-2024-6000", { cvss: 7.2 });
        // The application binary itself, fixed below the candidate's app version.
        await finding(sbom.id, "github.com/prometheus/prometheus", onApp.id, {
            version: "2.51.0",
            purl: "pkg:golang/github.com/prometheus/prometheus@2.51.0",
            fixedVersion: "2.52.0",
        });
        // A library inside it — fixable, but not the application, so it must
        // not tighten the bound.
        await finding(sbom.id, "golang.org/x/net", onLib.id, {
            version: "0.19.0",
            purl: "pkg:golang/golang.org/x/net@0.19.0",
            fixedVersion: "0.23.0",
        });

        const [repo] = await db
            .insert(schema.chartRepositories)
            .values({ orgId: org.id, url: REPO_URL, source: "observed", enabled: true })
            .returning();
        await db.insert(schema.chartRepoEntries).values({
            repositoryId: repo!.id,
            chartName: "prometheus",
            versions: [{ version: "61.2.0", appVersion: "2.54.0", tarballUrl: null }],
            fetchedAt: new Date(),
        });

        const res = await request(app)
            .get("/api/remediation/rollup")
            .set(
                createInternalHeaders({
                    id: scenario.user.id,
                    email: scenario.user.email,
                    orgId: org.id,
                })
            );
        expect(res.status).toBe(200);

        const suggestion = res.body.suggestions.find(
            (s: { type: string }) => s.type === "chart-newer-unmeasured"
        );
        expect(suggestion).toMatchObject({
            targetVersion: "61.2.0",
            source: "chart-repository",
            // Context, never evidence — the chart bump moves the packaged app.
            appVersionMove: { from: "2.51.0", to: "2.54.0" },
            // Both findings are fixable; exactly one is on the application
            // itself with its fix at or below the candidate's app version.
            fixableFindings: 2,
            fixesAtCandidateAppVersion: 1,
        });
    });
});
