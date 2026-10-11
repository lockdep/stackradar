/**
 * The suggestion feed — the rollup `GET /api/remediation/fixes` is built from,
 * exercised through `fixRollupForOrg` (the rollup route itself is gone).
 *
 * What must hold end to end:
 * - the rollup emits both axes as one ranked suggestion list, and a measured
 *   chart bump subsumes the image moves it covers without discarding them;
 * - an unmeasured "newer chart" suggestion is a weaker class: it claims an
 *   upper bound, never a delta, and sits below every measured suggestion;
 * - a cluster scope narrows rows and suggestions to one cluster, and every
 *   suggestion names its cluster either way.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createCluster,
    createImage,
    createSbom,
    createHelmRelease,
    createGitopsApplication,
    createNamespace,
    createWorkload,
    createWorkloadContainer,
    withFindingIdentity,
    type SeedTestScenarioResult,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

let scenario: SeedTestScenarioResult;

/** The rollup behind `GET /api/remediation/fixes`, serialised as the route would. */
async function rollup(orgId: string, clusterId: string | null = null) {
    const { fixRollupForOrg } = await import("../../../src/services/remediation-rollup.service.js");
    return { status: 200, body: JSON.parse(JSON.stringify(await fixRollupForOrg(orgId, clusterId))) };
}

async function advisory(vulnId: string, opts: { cvss?: number; epss?: number; kev?: boolean } = {}) {
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
                    epssScore: opts.epss ?? null,
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

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("the suggestion feed", () => {
    it("emits a measured chart-upgrade suggestion that subsumes the image move it covers", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;

        const oldRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "kps",
            namespace: "monitoring",
            chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
        });
        const stagingRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "kps-staging",
            namespace: "monitoring-staging",
            chartName: "kube-prometheus-stack",
            chartVersion: "83.1.0",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
        });
        const argo = await createGitopsApplication(db, org.id, cluster.id, {
            name: "kube-prometheus-stack",
            namespace: "argocd",
            tool: "argocd",
            targetRevision: "82.18.0",
        });

        const oldImage = await createImage(db, org.id, cluster.id, {
            repository: "quay.io/prometheus/prometheus",
            digest: "sha256:" + "5".repeat(64),
        });
        const newImage = await createImage(db, org.id, cluster.id, {
            repository: "quay.io/prometheus/prometheus",
            digest: "sha256:" + "6".repeat(64),
        });

        const ns = await createNamespace(db, org.id, cluster.id, { name: "monitoring" });
        const oldWorkload = await createWorkload(db, org.id, ns.id, {
            name: "prometheus",
            releaseId: oldRelease.id,
            applicationId: argo.id,
        });
        await createWorkloadContainer(db, org.id, oldWorkload.id, oldImage.id, {
            name: "prometheus",
            imageTag: "v2.50.0",
        });

        const nsStaging = await createNamespace(db, org.id, cluster.id, { name: "monitoring-staging" });
        const newWorkload = await createWorkload(db, org.id, nsStaging.id, {
            name: "prometheus",
            releaseId: stagingRelease.id,
        });
        await createWorkloadContainer(db, org.id, newWorkload.id, newImage.id, {
            name: "prometheus",
            imageTag: "v2.54.0",
        });

        const oldSbom = await createSbom(db, { imageId: oldImage.id });
        await createSbom(db, { imageId: newImage.id });
        const kev = await advisory("CVE-2021-44228", { cvss: 10, epss: 0.97, kev: true });
        await finding(oldSbom.id, "log4j", kev.id, { fixedVersion: "2.17.0" });

        const res = await rollup(scenario.org.id);
        expect(res.status).toBe(200);

        const chart = res.body.suggestions.find((s: { type: string }) => s.type === "chart-upgrade");
        expect(chart).toBeDefined();
        expect(chart).toMatchObject({
            measured: true,
            clearsKev: true,
            release: { chartName: "kube-prometheus-stack", chartVersion: "82.18.0" },
            target: { chartVersion: "83.1.0" },
            bump: "major",
            matchKind: "repo-url",
            // ArgoCD delivers the release, so no helm command is offered —
            // the next sync would revert it.
            command: null,
            delivery: { tool: "argocd", appName: "kube-prometheus-stack" },
        });
        expect(chart.cluster.id).toBe(cluster.id);

        // The image move rides inside the chart suggestion — deliverable on
        // its own (it is chart-pinned, so it carries a values override) but
        // not a second top-level row.
        expect(chart.subsumes).toHaveLength(1);
        expect(chart.subsumes[0]).toMatchObject({
            type: "image-override",
            image: { id: oldImage.id },
            best: { tag: "v2.54.0" },
        });
        expect(chart.subsumes[0].override.snippet).toContain('tag: "v2.54.0"');
        expect(
            res.body.suggestions.filter(
                (s: { type: string }) => s.type === "image-override" || s.type === "image-tag-upgrade",
            ),
        ).toHaveLength(0);

        expect(res.body.totals.suggestions.measured).toBeGreaterThan(0);
    });

    it("keeps an unmeasured newer-chart suggestion below every measured one, claiming only an upper bound", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;

        // A sibling release at a newer chart version whose image nobody
        // scanned → unmeasured.
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
        // No SBOM for appNew — that is what makes the sibling unmeasured.
        await finding(prodSbom.id, "libfoo", (await advisory("CVE-2024-5000", { cvss: 8 })).id, {
            fixedVersion: "2.0.0",
        });

        // And a measured image move elsewhere, with a tiny risk delta.
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

        const res = await rollup(scenario.org.id);
        expect(res.status).toBe(200);

        const types = res.body.suggestions.map((s: { type: string; measured: boolean }) => s);
        const unmeasuredIdx = types.findIndex((s: { type: string }) => s.type === "chart-newer-unmeasured");
        expect(unmeasuredIdx).toBeGreaterThan(-1);

        const unmeasured = res.body.suggestions[unmeasuredIdx];
        expect(unmeasured).toMatchObject({
            measured: false,
            riskRemoved: null,
            source: "sibling-release",
            targetVersion: "1.1.0",
            release: { id: prodRelease.id },
        });
        // The upper bound: Σ risk of the release's fixable findings, present
        // and positive — "could address up to", never a measured delta.
        expect(unmeasured.upperBoundRisk).toBeGreaterThan(0);
        expect(unmeasured.fixableFindings).toBe(1);

        // Every measured suggestion sits above it, even the tiny one.
        for (let i = 0; i < unmeasuredIdx; i++) {
            expect(res.body.suggestions[i].measured).toBe(true);
        }
        const measuredIdx = res.body.suggestions.findIndex((s: { type: string }) => s.type === "image-tag-upgrade");
        expect(measuredIdx).toBeGreaterThan(-1);
        expect(measuredIdx).toBeLessThan(unmeasuredIdx);
    });

    it("scopes rows and suggestions to one cluster via ?cluster=", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const other = await createCluster(db, org.id, { name: "staging" });

        const seedEol = async (clusterId: string, digestChar: string) => {
            const image = await createImage(db, org.id, clusterId, {
                repository: `acme/app-${digestChar}`,
                digest: "sha256:" + digestChar.repeat(64),
            });
            await seedRunningImage(db, org.id, clusterId, {
                image,
                workloadName: `w-${digestChar}`,
                namespace: "default",
                imageTag: "3.16",
            });
            const sbom = await createSbom(db, { imageId: image.id });
            await finding(sbom.id, `pkg-${digestChar}`, (await advisory(`CVE-2024-70${digestChar.charCodeAt(0)}`)).id, {
                fixedVersion: null,
                matchedEcosystem: "Alpine:v3.16",
            });
            return image;
        };
        const imageA = await seedEol(cluster.id, "a");
        const imageB = await seedEol(other.id, "b");

        const all = await rollup(scenario.org.id);
        expect(all.status).toBe(200);
        expect(all.body.clusterId).toBeNull();
        expect(all.body.rows).toHaveLength(2);
        expect(all.body.clusters.map((c: { id: string }) => c.id).sort()).toEqual([cluster.id, other.id].sort());
        // Every suggestion names its cluster.
        for (const s of all.body.suggestions) {
            expect([cluster.id, other.id]).toContain(s.cluster.id);
        }

        const scoped = await rollup(scenario.org.id, other.id);
        expect(scoped.status).toBe(200);
        expect(scoped.body.clusterId).toBe(other.id);
        expect(scoped.body.rows).toHaveLength(1);
        expect(scoped.body.rows[0].image.id).toBe(imageB.id);
        expect(scoped.body.suggestions.length).toBeGreaterThan(0);
        for (const s of scoped.body.suggestions) {
            expect(s.cluster.id).toBe(other.id);
        }
        expect(scoped.body.suggestions.some((s: { image?: { id: string } }) => s.image?.id === imageA.id)).toBe(false);
        // The selector still sees every cluster while the feed is scoped.
        expect(scoped.body.clusters).toHaveLength(2);
    });

    it("emits an EOL migration advisory for findings no fix will reach", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const image = await createImage(db, org.id, cluster.id, { repository: "library/alpine" });
        await seedRunningImage(db, org.id, cluster.id, {
            image,
            workloadName: "legacy",
            namespace: "default",
            imageTag: "3.16",
        });
        const sbom = await createSbom(db, { imageId: image.id });
        await finding(sbom.id, "zlib", (await advisory("CVE-2024-0002")).id, {
            fixedVersion: null,
            matchedEcosystem: "Alpine:v3.16",
        });

        const res = await rollup(scenario.org.id);
        expect(res.status).toBe(200);

        const eol = res.body.suggestions.find((s: { type: string }) => s.type === "eol-migration");
        expect(eol).toMatchObject({
            measured: false,
            image: { id: image.id },
            findings: 1,
            lines: [{ releaseLine: "Alpine 3.16", eolDate: "2024-05-23", findings: 1 }],
        });
        expect(eol.impact).toBeGreaterThan(0);
    });
});
