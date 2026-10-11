/**
 * "Move to `node:20.18-slim` — clears 23 findings, 4 of them high, 1 on KEV."
 *
 * The acceptance criteria of `base-image-recommendations.md` phases 1 and 2,
 * one test each. Several of them assert that we say *nothing*, and those are
 * the load-bearing ones: this feature's failure mode is not a missed
 * recommendation, it is a confident wrong one — a distro change sold as a patch
 * bump, or "not chart-managed" said about a cluster we were not allowed to look
 * at.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import {
    seedTestScenario,
    seedRunningImage,
    createImage,
    createSbom,
    createHelmRelease,
    createGitopsApplication,
    createWorkloadContainer,
    createWorkload,
    createNamespace,
    withFindingIdentity,
} from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";

type Service = typeof import("../../../src/services/upgrade-recommendation.service.js");

async function service(): Promise<Service> {
    return import("../../../src/services/upgrade-recommendation.service.js");
}

/** An advisory shared across images, so a finding can persist or be cleared. */
async function advisory(
    vulnId: string,
    opts: { cvss: number; epss?: number | null; kev?: boolean; severity?: string } = { cvss: 7.5 },
) {
    const db = getTestDb();
    const [row] = await db
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity([
                {
                    vulnId,
                    source: "osv",
                    cvssScore: opts.cvss,
                    severityLevel: opts.severity ?? (opts.cvss >= 9 ? "critical" : opts.cvss >= 7 ? "high" : "medium"),
                    epssScore: opts.epss ?? null,
                    kevListedAt: opts.kev ? new Date("2021-12-10") : null,
                    aliases: [],
                },
            ]),
        )
        .returning();
    return row!;
}

/** Put `packageName` on `sbomId` and match it to `vulnerabilityId`. */
async function vulnerablePackage(sbomId: string, packageName: string, vulnerabilityId: string) {
    const db = getTestDb();
    const [component] = await db
        .insert(schema.components)
        .values({
            sbomId,
            name: packageName,
            version: "1.0.0",
            purl: `pkg:deb/debian/${packageName}@1.0.0`,
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
    });
}

/**
 * A repository running at two tags in one org: `20.11-slim` with three
 * findings, `20.18-slim` with one of them still present and one new.
 */
async function seedTwoTags(orgId: string, clusterId: string) {
    const db = getTestDb();

    const oldImage = await createImage(db, orgId, clusterId, {
        repository: "library/node",
        digest: "sha256:" + "a".repeat(64),
    });
    const newImage = await createImage(db, orgId, clusterId, {
        repository: "library/node",
        digest: "sha256:" + "b".repeat(64),
    });

    const old = await seedRunningImage(db, orgId, clusterId, {
        image: oldImage,
        workloadName: "api",
        imageTag: "20.11-slim",
        namespace: "default",
    });
    await seedRunningImage(db, orgId, clusterId, {
        image: newImage,
        workloadName: "worker",
        imageTag: "20.18-slim",
        namespace: "jobs",
    });

    const oldSbom = await createSbom(db, { imageId: oldImage.id });
    const newSbom = await createSbom(db, { imageId: newImage.id });

    const kevCritical = await advisory("CVE-2021-44228", { cvss: 10, epss: 0.97, kev: true });
    const high = await advisory("CVE-2024-1000", { cvss: 8.1, epss: 0.3 });
    const persists = await advisory("CVE-2024-2000", { cvss: 6.5, epss: 0.05 });
    const introduced = await advisory("CVE-2024-3000", { cvss: 5.3, epss: 0.02 });

    // Old image: cleared-KEV, cleared-high, and one that survives the bump.
    await vulnerablePackage(oldSbom.id, "log4j", kevCritical.id);
    await vulnerablePackage(oldSbom.id, "openssl", high.id);
    await vulnerablePackage(oldSbom.id, "zlib", persists.id);

    // New image: the survivor on the same package, plus something new.
    await vulnerablePackage(newSbom.id, "zlib", persists.id);
    await vulnerablePackage(newSbom.id, "libxml2", introduced.id);

    return { oldImage, newImage, workload: old.workload };
}

describe("image axis — a newer scanned tag", () => {
    beforeAll(async () => {
        await cleanAllData();
    });
    beforeEach(async () => {
        await cleanAllData();
    });

    it("recommends the newer tag with resolved, introduced and remaining counts", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { oldImage, newImage } = await seedTwoTags(org.id, cluster.id);

        const { recommendForImage } = await service();
        const result = await recommendForImage(org.id, oldImage.id);

        expect(result.availability).toBe("available");
        expect(result.current.tag).toBe("20.11-slim");
        expect(result.best).toMatchObject({ tag: "20.18-slim", imageId: newImage.id, bump: "minor" });

        const summary = result.best!.summary;
        expect(summary.resolved).toBe(2);
        expect(summary.resolvedKev).toBe(1);
        expect(summary.resolvedHigh).toBe(2); // the KEV critical and the high
        expect(summary.introduced).toBe(1);
        expect(summary.unchanged).toBe(1);

        // The move must be priced in risk, not only in counts — that is the
        // whole reason the two features were built together.
        expect(summary.riskAfter).toBeLessThan(summary.riskBefore);
        expect(summary.riskChange).toBeLessThan(0);
    });

    it("lists the findings the bump does not fix", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const { oldImage } = await seedTwoTags(org.id, cluster.id);

        const { recommendForImage } = await service();
        const result = await recommendForImage(org.id, oldImage.id);

        // "so the customer knows the bump is not the whole fix"
        expect(result.remaining.map((f) => f.vulnId)).toEqual(["CVE-2024-2000"]);
    });

    it("never compares across a variant boundary, and says it skipped them", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        const current = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "c".repeat(64),
        });
        const alpine = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "d".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, { image: current, imageTag: "20.11-slim", workloadName: "api" });
        await seedRunningImage(db, org.id, cluster.id, {
            image: alpine,
            imageTag: "20.18-alpine",
            workloadName: "other",
        });
        await createSbom(db, { imageId: current.id });
        await createSbom(db, { imageId: alpine.id });

        const { recommendForImage } = await service();
        const result = await recommendForImage(org.id, current.id);

        // A newer *number* exists and we refuse it. Saying "up-to-date" here
        // would be false; recommending it would move the base distro.
        expect(result.best).toBeNull();
        expect(result.availability).toBe("ambiguous-ordering");
        expect(result.skipped).toEqual([{ tag: "20.18-alpine", reason: "different-variant" }]);
    });

    it("distinguishes up-to-date from nothing-to-compare", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        const newest = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "e".repeat(64),
        });
        const older = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "f".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, { image: newest, imageTag: "20.18-slim", workloadName: "api" });
        await seedRunningImage(db, org.id, cluster.id, { image: older, imageTag: "20.11-slim", workloadName: "old" });
        await createSbom(db, { imageId: newest.id });
        await createSbom(db, { imageId: older.id });

        const { recommendForImage } = await service();
        expect((await recommendForImage(org.id, newest.id)).availability).toBe("up-to-date");
    });

    it("says nothing for a digest-pinned deployment", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        const image = await createImage(db, org.id, cluster.id, { repository: "library/node" });
        // `imageTag: null` is the honest record of `image: repo@sha256:…`.
        await seedRunningImage(db, org.id, cluster.id, { image, imageTag: null });
        await createSbom(db, { imageId: image.id });

        const { recommendForImage } = await service();
        const result = await recommendForImage(org.id, image.id);
        expect(result.availability).toBe("no-candidates");
        expect(result.current.tag).toBeNull();
    });

    it("does not offer a candidate that has never been scanned", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        const current = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "1".repeat(64),
        });
        const unscanned = await createImage(db, org.id, cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "2".repeat(64),
        });
        await seedRunningImage(db, org.id, cluster.id, { image: current, imageTag: "20.11-slim", workloadName: "api" });
        await seedRunningImage(db, org.id, cluster.id, {
            image: unscanned,
            imageTag: "20.18-slim",
            workloadName: "other",
        });
        await createSbom(db, { imageId: current.id });
        // No SBOM for the newer tag — we cannot price the move, so we do not
        // make one. Inventing it from a version number is what this is not.

        const { recommendForImage } = await service();
        expect((await recommendForImage(org.id, current.id)).availability).toBe("no-candidates");
    });

    it("does not look outside the org", async () => {
        const db = getTestDb();
        const mine = await seedTestScenario(db);
        const theirs = await seedTestScenario(db);

        // The same repository in two tenants — two image rows now that images
        // are cluster-scoped. Their tag must not leak into my recommendation.
        const current = await createImage(db, mine.org.id, mine.cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "3".repeat(64),
        });
        const newer = await createImage(db, theirs.org.id, theirs.cluster.id, {
            repository: "library/node",
            digest: "sha256:" + "4".repeat(64),
        });
        await seedRunningImage(db, mine.org.id, mine.cluster.id, { image: current, imageTag: "20.11-slim" });
        await seedRunningImage(db, theirs.org.id, theirs.cluster.id, { image: newer, imageTag: "20.18-slim" });
        await createSbom(db, { imageId: current.id });
        await createSbom(db, { imageId: newer.id });

        const { recommendForImage } = await service();
        const result = await recommendForImage(mine.org.id, current.id);
        expect(result.availability).toBe("no-candidates");
        expect(result.skipped).toEqual([]);
    });
});

describe("chart axis — a newer chart version", () => {
    beforeAll(async () => {
        await cleanAllData();
    });
    beforeEach(async () => {
        await cleanAllData();
    });

    it("prices one helm upgrade and names what delivers it", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        const oldRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "kps",
            namespace: "monitoring",
            chartName: "kube-prometheus-stack",
            chartVersion: "82.18.0",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
        });
        const newRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "kps-staging",
            namespace: "monitoring-staging",
            chartName: "kube-prometheus-stack",
            chartVersion: "83.1.0",
            repoUrl: "https://prometheus-community.github.io/helm-charts",
        });

        const app = await createGitopsApplication(db, org.id, cluster.id, {
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
            applicationId: app.id,
        });
        await createWorkloadContainer(db, org.id, oldWorkload.id, oldImage.id, { name: "prometheus" });

        const nsStaging = await createNamespace(db, org.id, cluster.id, { name: "monitoring-staging" });
        const newWorkload = await createWorkload(db, org.id, nsStaging.id, {
            name: "prometheus",
            releaseId: newRelease.id,
        });
        await createWorkloadContainer(db, org.id, newWorkload.id, newImage.id, { name: "prometheus" });

        const oldSbom = await createSbom(db, { imageId: oldImage.id });
        await createSbom(db, { imageId: newImage.id });
        const kev = await advisory("CVE-2021-44228", { cvss: 10, epss: 0.97, kev: true });
        await vulnerablePackage(oldSbom.id, "log4j", kev.id);

        const { recommendForRelease } = await service();
        const result = await recommendForRelease(org.id, oldRelease.id);

        expect(result.availability).toBe("available");
        expect(result.matchKind).toBe("repo-url");
        expect(result.bump).toBe("major");
        expect(result.target?.chartVersion).toBe("83.1.0");
        expect(result.imageMoves).toHaveLength(1);
        expect(result.imageMoves[0]!.summary.resolvedKev).toBe(1);
        // "bump targetRevision on app X" and not "run helm upgrade" — the next
        // Argo sync would revert the latter.
        expect(result.delivery).toMatchObject({ tool: "argocd", appName: "kube-prometheus-stack" });
    });

    it("labels a name-only chart match as one", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        // Neither release knows its repoUrl — pod metadata cannot supply it.
        // Several repositories publish `nginx`, so the match is a guess and the
        // caller has to be told.
        await createHelmRelease(db, org.id, cluster.id, {
            name: "nginx-b",
            namespace: "b",
            chartName: "nginx",
            chartVersion: "18.2.0",
            repoUrl: null,
        });
        const mine = await createHelmRelease(db, org.id, cluster.id, {
            name: "nginx-a",
            namespace: "a",
            chartName: "nginx",
            chartVersion: "18.1.0",
            repoUrl: null,
        });

        const { recommendForRelease } = await service();
        const result = await recommendForRelease(org.id, mine.id);
        expect(result.matchKind).toBe("chart-name");
    });

    it("does not match a chart of the same name from a different repo", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        await createHelmRelease(db, org.id, cluster.id, {
            name: "nginx-bitnami",
            namespace: "b",
            chartName: "nginx",
            chartVersion: "18.2.0",
            repoUrl: "https://charts.bitnami.com/bitnami",
        });
        const mine = await createHelmRelease(db, org.id, cluster.id, {
            name: "nginx-ingress",
            namespace: "a",
            chartName: "nginx",
            chartVersion: "4.1.0",
            repoUrl: "https://kubernetes.github.io/ingress-nginx",
        });

        const { recommendForRelease } = await service();
        const result = await recommendForRelease(org.id, mine.id);
        expect(result.availability).toBe("no-candidates");
        expect(result.target).toBeNull();
    });

    it("reports not-measured when the newer chart's images have no SBOM", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);

        const oldRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "app-prod",
            namespace: "prod",
            chartName: "app",
            chartVersion: "1.0.0",
            repoUrl: "https://charts.example.com",
        });
        const newRelease = await createHelmRelease(db, org.id, cluster.id, {
            name: "app-dev",
            namespace: "dev",
            chartName: "app",
            chartVersion: "1.1.0",
            repoUrl: "https://charts.example.com",
        });

        const oldImage = await createImage(db, org.id, cluster.id, {
            repository: "acme/app",
            digest: "sha256:" + "7".repeat(64),
        });
        const newImage = await createImage(db, org.id, cluster.id, {
            repository: "acme/app",
            digest: "sha256:" + "8".repeat(64),
        });

        const nsProd = await createNamespace(db, org.id, cluster.id, { name: "prod" });
        const w1 = await createWorkload(db, org.id, nsProd.id, { name: "app", releaseId: oldRelease.id });
        await createWorkloadContainer(db, org.id, w1.id, oldImage.id);

        const nsDev = await createNamespace(db, org.id, cluster.id, { name: "dev" });
        const w2 = await createWorkload(db, org.id, nsDev.id, { name: "app", releaseId: newRelease.id });
        await createWorkloadContainer(db, org.id, w2.id, newImage.id);

        await createSbom(db, { imageId: oldImage.id });
        // Nothing has scanned the newer chart's image.

        const { recommendForRelease } = await service();
        const result = await recommendForRelease(org.id, oldRelease.id);

        // The third state the proposal insists on: distinct from "no newer
        // version" and from "no fix available".
        expect(result.availability).toBe("not-measured");
        expect(result.target?.chartVersion).toBe("1.1.0");
        expect(result.unmeasuredImages).toBeGreaterThan(0);
        expect(result.imageMoves).toEqual([]);
    });
});

describe("owner metadata", () => {
    beforeAll(async () => {
        await cleanAllData();
    });
    beforeEach(async () => {
        await cleanAllData();
    });

    it("refuses to confirm a workload is unmanaged when the agent could not look", async () => {
        const db = getTestDb();
        const { cluster } = await seedTestScenario(db);
        const { ownerMetadataKnown } = await service();

        // `null` — no inventory report has landed yet.
        expect(await ownerMetadataKnown(cluster.id)).toBe(false);

        // `false` — the agent was not permitted to read controllers. A
        // workload with no release row here may well be chart-managed, so no
        // "use kubectl set image" copy may be emitted.
        await db
            .update(schema.clusters)
            .set({ ownerMetadataCollected: false })
            .where(eq(schema.clusters.id, cluster.id));
        expect(await ownerMetadataKnown(cluster.id)).toBe(false);

        await db
            .update(schema.clusters)
            .set({ ownerMetadataCollected: true })
            .where(eq(schema.clusters.id, cluster.id));
        expect(await ownerMetadataKnown(cluster.id)).toBe(true);
    });
});
