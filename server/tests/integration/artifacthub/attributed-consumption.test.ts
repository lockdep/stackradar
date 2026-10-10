/**
 * Attribution on the read side — docs/proposals/artifact-hub-mirror.md
 * phase 3. What must hold:
 *
 * - `recommendForRelease` resolves a null repo through the attribution,
 *   labels the match `attributed`, and narrows siblings to the attributed
 *   repo or null — never a different observed one;
 * - `mirrorNewer` is a separate, honestly-unmeasured statement, offered only
 *   when the sibling scan found nothing, with deprecated versions skipped;
 * - the suggestion feed's mirror fallback fires when a chart has an
 *   attribution but no cached `chart_repo_entries` — the case the old
 *   `chartEntries.length > 0` gate silently swallowed — and repo entries
 *   still win when they exist;
 * - the release detail carries `attributedRepoUrl` / `chartDeprecated`, and
 *   `chartNameAmbiguous` clears when the attribution resolves null repos.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
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
import type { ArtifactHubVersion } from "../../../src/db/schema/artifact-hub.js";

type Service = typeof import("../../../src/services/upgrade-recommendation.service.js");

async function service(): Promise<Service> {
    return import("../../../src/services/upgrade-recommendation.service.js");
}

let app: Awaited<ReturnType<typeof getTestApp>>;
let scenario: SeedTestScenarioResult;

function authHeaders() {
    return createInternalHeaders({
        id: scenario.user.id,
        email: scenario.user.email,
        orgId: scenario.org.id,
    });
}

/** A mirror package plus the attribution row the nightly pass would write. */
async function attribute(
    orgId: string,
    chartName: string,
    repoUrl: string,
    versions: ArtifactHubVersion[],
    opts: { latestVersion?: string } = {}
) {
    const db = getTestDb();
    const [pkg] = await db
        .insert(schema.artifactHubPackages)
        .values({
            name: chartName,
            repoName: `repo-${chartName}`,
            repoUrl,
            latestVersion: opts.latestVersion ?? versions[versions.length - 1]?.pkg ?? null,
            versions,
            lastSeenAt: new Date(),
        })
        .returning();
    await db.insert(schema.chartAttributions).values({
        orgId,
        chartName,
        packageId: pkg!.id,
        repoUrl,
        evidence: { installs: [], scores: [] },
        matchedAt: new Date(),
    });
    return pkg!;
}

const v = (pkg: string, extra: Partial<ArtifactHubVersion> = {}): ArtifactHubVersion => ({
    pkg,
    app: null,
    kube: null,
    deprecated: false,
    ...extra,
});

/** A release with one scanned image carrying one fixable finding. */
async function releaseWithFixableFinding(
    name: string,
    options: { chartName: string; chartVersion: string; repoUrl?: string | null }
) {
    const db = getTestDb();
    const { org, cluster } = scenario;
    const release = await createHelmRelease(db, org.id, cluster.id, {
        name,
        namespace: name,
        chartName: options.chartName,
        chartVersion: options.chartVersion,
        repoUrl: options.repoUrl ?? null,
    });
    const image = await createImage(db, org.id, cluster.id, {
        repository: `registry.example.com/${name}`,
        digest: "sha256:" + name.replace(/[^a-f0-9]/g, "a").padEnd(64, "0").slice(0, 64),
    });
    const ns = await createNamespace(db, org.id, cluster.id, { name });
    const workload = await createWorkload(db, org.id, ns.id, { name, releaseId: release.id });
    await createWorkloadContainer(db, org.id, workload.id, image.id, {
        name,
        imageTag: "1.0.0",
    });
    const sbom = await createSbom(db, { imageId: image.id });

    const [vuln] = await db
        .insert(schema.vulnerabilities)
        .values(withFindingIdentity([{
            vulnId: `CVE-2024-${Math.abs(hash(name)) % 90_000 + 10_000}`,
            source: "osv",
            cvssScore: 8.1,
            severityLevel: "high",
            aliases: [],
        }]))
        .returning();
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId: sbom.id,
            name: `${name}-lib`,
            version: "1.0.0",
            purl: `pkg:apk/alpine/${name}-lib@1.0.0`,
            type: "library",
            isDirect: true,
        })
        .returning();
    await db.insert(schema.componentVulnerabilities).values({
        componentId: component!.id,
        vulnerabilityId: vuln!.id,
        matchedBy: "purl",
        matchType: "direct",
        matchConfidence: "exact",
        fixedVersion: "2.0.0",
    });
    return release;
}

function hash(s: string): number {
    let h = 0;
    for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
    return h;
}

beforeAll(async () => {
    app = await getTestApp();
});

beforeEach(async () => {
    await cleanAllData();
    scenario = await seedTestScenario(getTestDb());
});

describe("recommendForRelease with an attribution", () => {
    it("labels the match attributed and narrows siblings to the attributed repo or null", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const { recommendForRelease } = await service();

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "redis", namespace: "a",
            chartName: "redis", chartVersion: "17.0.0", repoUrl: null,
        });
        // Shares the attribution by construction: same (org, chart), null repo.
        await createHelmRelease(db, org.id, cluster.id, {
            name: "redis-b", namespace: "b",
            chartName: "redis", chartVersion: "18.0.0", repoUrl: null,
        });
        // A *different observed* repo is a different chart — must be excluded
        // even though its version is the newest.
        await createHelmRelease(db, org.id, cluster.id, {
            name: "redis-c", namespace: "c",
            chartName: "redis", chartVersion: "19.0.0",
            repoUrl: "https://other.example.com/charts",
        });
        await attribute(org.id, "redis", "https://charts.bitnami.com/bitnami", [
            v("17.0.0"), v("18.0.0"),
        ]);

        const rec = await recommendForRelease(org.id, release.id);
        expect(rec.matchKind).toBe("attributed");
        expect(rec.release.attributedRepoUrl).toBe("https://charts.bitnami.com/bitnami");
        expect(rec.target?.chartVersion).toBe("18.0.0");
    });

    it("offers mirrorNewer when no sibling exists, skipping deprecated versions", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const { recommendForRelease } = await service();

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "solo", namespace: "solo",
            chartName: "solo-chart", chartVersion: "1.0.0", repoUrl: null,
        });
        await attribute(org.id, "solo-chart", "https://charts.example.com", [
            v("1.0.0"),
            v("1.1.0", { kube: ">=1.25.0-0" }),
            // Newest, but deprecated — never a move to suggest.
            v("2.0.0", { deprecated: true }),
        ]);

        const rec = await recommendForRelease(org.id, release.id);
        expect(rec.availability).toBe("no-candidates");
        expect(rec.matchKind).toBe("attributed");
        expect(rec.target).toBeNull();
        expect(rec.mirrorNewer).toEqual({ version: "1.1.0", kube: ">=1.25.0-0" });
    });

    it("warns when the target's kubeVersion range excludes the cluster — and only then", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const { recommendForRelease } = await service();

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "kube", namespace: "kube",
            chartName: "kube-chart", chartVersion: "1.0.0", repoUrl: null,
        });
        await attribute(org.id, "kube-chart", "https://charts.example.com", [
            v("1.0.0"),
            v("2.0.0", { kube: ">=1.32.0-0" }),
        ]);

        // Cluster version unknown → silence, even though the range is known.
        const before = await recommendForRelease(org.id, release.id);
        expect(before.mirrorNewer?.version).toBe("2.0.0");
        expect(before.kubeWarning).toBeNull();

        await db
            .update(schema.clusters)
            .set({ kubernetesVersion: "v1.29.4+k3s1" })
            .where(eq(schema.clusters.id, cluster.id));

        const after = await recommendForRelease(org.id, release.id);
        expect(after.kubeWarning).toEqual({
            clusterVersion: "v1.29.4+k3s1",
            kubeRange: ">=1.32.0-0",
        });
    });

    it("refuses an attribution that names a different repo than the observed one", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const { recommendForRelease } = await service();

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "observed", namespace: "observed",
            chartName: "observed-chart", chartVersion: "1.0.0",
            repoUrl: "https://observed.example.com",
        });
        await attribute(org.id, "observed-chart", "https://elsewhere.example.com", [
            v("1.0.0"), v("9.9.9"),
        ]);

        const rec = await recommendForRelease(org.id, release.id);
        expect(rec.matchKind).toBe("repo-url");
        expect(rec.release.attributedRepoUrl).toBeNull();
        // Same chart name, different repository: a different chart. The
        // mirror's version list belongs to that other chart and says nothing
        // about this one.
        expect(rec.mirrorNewer).toBeNull();
    });

    /**
     * The observed repo stays authoritative for *identity* — `matchKind` is
     * still `repo-url` and nothing is attributed — but a package published
     * from that same repository is the only version list we hold for a chart
     * no sibling runs. Gating the mirror on a null `repoUrl` meant the
     * releases we knew most about were the ones we could say least about.
     */
    it("reads the mirror for an observed repo the attributed package agrees with", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const { recommendForRelease } = await service();

        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "agreed", namespace: "agreed",
            chartName: "agreed-chart", chartVersion: "1.0.0",
            repoUrl: "https://agreed.example.com",
        });
        await attribute(org.id, "agreed-chart", "https://agreed.example.com", [
            v("1.0.0"), v("1.4.0"),
        ]);

        const rec = await recommendForRelease(org.id, release.id);
        expect(rec.matchKind).toBe("repo-url");
        // An observed repo is never "attributed", however much evidence agrees.
        expect(rec.release.attributedRepoUrl).toBeNull();
        expect(rec.mirrorNewer).toEqual({ version: "1.4.0", kube: null });
    });
});

describe("GET /api/releases/:id/upgrade", () => {
    it("returns mirrorNewer over the wire", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "wire", namespace: "wire",
            chartName: "wire-chart", chartVersion: "0.5.0", repoUrl: null,
        });
        await attribute(org.id, "wire-chart", "https://charts.example.com", [
            v("0.5.0"), v("0.6.0"),
        ]);

        const res = await request(app).get(`/api/releases/${release.id}/upgrade`).set(authHeaders());
        expect(res.status).toBe(200);
        expect(res.body.matchKind).toBe("attributed");
        expect(res.body.mirrorNewer).toEqual({ version: "0.6.0", kube: null });
    });
});

describe("suggestion feed — mirror fallback", () => {
    it("fires with zero chart_repo_entries, the case the old gate swallowed", async () => {
        const { org } = scenario;
        await releaseWithFixableFinding("feed", {
            chartName: "feed-chart",
            chartVersion: "3.0.0",
        });
        await attribute(org.id, "feed-chart", "https://charts.example.com", [
            v("3.0.0"), v("3.2.0"),
        ]);

        const res = await request(app).get("/api/remediation/rollup").set(authHeaders());
        expect(res.status).toBe(200);

        const suggestion = res.body.suggestions.find(
            (s: { type: string }) => s.type === "chart-newer-unmeasured"
        );
        expect(suggestion).toMatchObject({
            targetVersion: "3.2.0",
            matchKind: "attributed",
            source: "artifact-hub-mirror",
        });
        expect(suggestion.release.attributedRepoUrl).toBe("https://charts.example.com");
        expect(suggestion.release.chartDeprecated).toBe(false);
    });

    it("prefers the repository's own entries over the mirror when they exist", async () => {
        const db = getTestDb();
        const { org } = scenario;
        await releaseWithFixableFinding("pref", {
            chartName: "pref-chart",
            chartVersion: "3.0.0",
        });
        await attribute(org.id, "pref-chart", "https://charts.example.com", [
            v("3.0.0"), v("3.2.0"),
        ]);

        // The auto-added repo has since had its index synced; the index is
        // fresher than the mirror and must win.
        const [repo] = await db
            .insert(schema.chartRepositories)
            .values({
                orgId: org.id,
                url: "https://charts.example.com",
                source: "artifact-hub-matched",
                enabled: true,
            })
            .returning();
        await db.insert(schema.chartRepoEntries).values({
            repositoryId: repo!.id,
            chartName: "pref-chart",
            versions: [{ version: "3.5.0", appVersion: null, tarballUrl: null }],
            fetchedAt: new Date(),
        });

        const res = await request(app).get("/api/remediation/rollup").set(authHeaders());
        const suggestion = res.body.suggestions.find(
            (s: { type: string }) => s.type === "chart-newer-unmeasured"
        );
        expect(suggestion).toMatchObject({
            targetVersion: "3.5.0",
            matchKind: "attributed",
            source: "chart-repository",
        });
    });

    it("suggests nothing when the only newer mirror version is deprecated", async () => {
        const { org } = scenario;
        await releaseWithFixableFinding("dep", {
            chartName: "dep-chart",
            chartVersion: "1.0.0",
        });
        await attribute(org.id, "dep-chart", "https://charts.example.com", [
            v("1.0.0"), v("2.0.0", { deprecated: true }),
        ]);

        const res = await request(app).get("/api/remediation/rollup").set(authHeaders());
        const unmeasured = res.body.suggestions.filter(
            (s: { type: string }) => s.type === "chart-newer-unmeasured"
        );
        expect(unmeasured).toHaveLength(0);
    });
});

describe("GET /api/releases/:id — attribution on the detail page", () => {
    it("carries attributedRepoUrl and chartDeprecated, and clears chartNameAmbiguous", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;

        // Two null-repo releases of one chart: the silent-merge case that
        // flags ambiguous — until the attribution names their repository.
        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "amb-a", namespace: "amb-a",
            chartName: "amb-chart", chartVersion: "1.0.0", repoUrl: null,
        });
        await createHelmRelease(db, org.id, cluster.id, {
            name: "amb-b", namespace: "amb-b",
            chartName: "amb-chart", chartVersion: "1.1.0", repoUrl: null,
        });

        const before = await request(app).get(`/api/releases/${release.id}`).set(authHeaders());
        expect(before.body.release.chartNameAmbiguous).toBe(true);
        expect(before.body.release.attributedRepoUrl).toBeNull();
        // No attribution: "deprecated?" has no honest answer.
        expect(before.body.release.chartDeprecated).toBeNull();

        await attribute(org.id, "amb-chart", "https://charts.example.com", [
            v("1.0.0"), v("1.1.0"),
        ]);

        const after = await request(app).get(`/api/releases/${release.id}`).set(authHeaders());
        expect(after.body.release.chartNameAmbiguous).toBe(false);
        expect(after.body.release.attributedRepoUrl).toBe("https://charts.example.com");
        expect(after.body.release.chartDeprecated).toBe(false);
    });

    it("flags a deprecated chart through the attribution", async () => {
        const db = getTestDb();
        const { org, cluster } = scenario;
        const release = await createHelmRelease(db, org.id, cluster.id, {
            name: "old", namespace: "old",
            chartName: "old-chart", chartVersion: "0.3.2", repoUrl: null,
        });
        await attribute(
            org.id,
            "old-chart",
            "https://charts.example.com",
            [v("0.3.1"), v("0.3.2", { deprecated: true }), v("0.3.3", { deprecated: true })],
            { latestVersion: "0.3.3" }
        );

        const res = await request(app).get(`/api/releases/${release.id}`).set(authHeaders());
        expect(res.body.release.chartDeprecated).toBe(true);
    });
});
