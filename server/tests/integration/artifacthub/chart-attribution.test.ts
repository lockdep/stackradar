/**
 * The attribution pass, against a real database and the fixture mirror.
 *
 * The matcher's decision logic is pinned in
 * `tests/unit/lib/chart-attribution.test.ts`; what these tests own is the
 * plumbing — worklist grouping, stamp-and-prune, auto-add semantics
 * (including non-resurrection), OCI handling, and org isolation.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { createOrganization, createCluster, createHelmRelease } from "../../fixtures/seed-data.js";
import { parsePackages } from "../../../src/artifacthub-sync/parser.js";

type AttributionModule = typeof import("../../../src/artifacthub-sync/attribution.js");
type RepoModule = typeof import("../../../src/artifacthub-sync/repository.js");

async function modules(): Promise<{ attribution: AttributionModule; repo: RepoModule }> {
    return {
        attribution: await import("../../../src/artifacthub-sync/attribution.js"),
        repo: await import("../../../src/artifacthub-sync/repository.js"),
    };
}

const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/artifact-hub/nova-slice.json"
);

/** Load the fixture into the mirror, the same path the sync uses. */
async function seedMirror(repo: RepoModule) {
    const { packages } = parsePackages(JSON.parse(readFileSync(fixturePath, "utf-8")));
    await repo
        .createArtifactHubSyncRepository()
        .apply(packages, { stamp: new Date(), batchSize: 100, minPackages: 1 });
}

async function attributionRows(orgId?: string) {
    const db = getTestDb();
    return db
        .select()
        .from(schema.chartAttributions)
        .where(orgId ? eq(schema.chartAttributions.orgId, orgId) : undefined);
}

describe("Attribution pass", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        const db = getTestDb();
        await db.delete(schema.chartAttributions);
        await db.delete(schema.artifactHubPackages);
        await db.delete(schema.artifactHubSyncState);
        await db.delete(schema.chartRepositories);
        await db.delete(schema.helmReleases);
        await db.delete(schema.clusters);
        await db.delete(schema.organizations);
    });

    it("writes an attribution with evidence, and auto-adds the repository", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        // 28.0.5 exists only in bitnami's list — a clean single-candidate win.
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
            appVersion: "8.10.0",
        });

        const stats = await attribution.runAttributionPass();
        expect(stats).toMatchObject({
            chartsExamined: 1,
            attributionsWritten: 1,
            attributionsRefused: 0,
            reposAutoAdded: 1,
        });

        const [row] = await attributionRows(org.id);
        expect(row).toMatchObject({
            chartName: "redis",
            repoUrl: "https://charts.bitnami.com/bitnami",
        });
        const evidence = row!.evidence as { installs: unknown[]; scores: unknown[] };
        expect(evidence.installs).toEqual([{ chartVersion: "28.0.5", appVersion: "8.10.0" }]);
        expect(evidence.scores.length).toBeGreaterThan(0);

        // Auto-added, enabled, with the machine-evidence source — and visible
        // to the chart-repo sync's worklist.
        const [added] = await db
            .select()
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.orgId, org.id));
        expect(added).toMatchObject({
            url: "https://charts.bitnami.com/bitnami",
            source: "artifact-hub-matched",
            enabled: true,
        });
    });

    it("refuses ambiguous charts and counts the refusal", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        // A chart version the mirror has never heard of — identity evidence
        // is required, so authority never fills the gap.
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "0.0.1-homegrown",
        });

        const stats = await attribution.runAttributionPass();
        expect(stats).toMatchObject({ attributionsWritten: 0, attributionsRefused: 1, reposAutoAdded: 0 });
        expect(await attributionRows()).toHaveLength(0);
    });

    it("prunes an attribution when the release disappears", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        const release = await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
        });

        await attribution.runAttributionPass();
        expect(await attributionRows(org.id)).toHaveLength(1);

        await db.delete(schema.helmReleases).where(eq(schema.helmReleases.id, release.id));
        const stats = await attribution.runAttributionPass();
        expect(stats.chartsExamined).toBe(0);
        // Not installed → not attributed. The nightly prune is what keeps an
        // attribution from outliving its evidence.
        expect(await attributionRows(org.id)).toHaveLength(0);
    });

    it("never resurrects a repository the user deleted or disabled", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
        });

        // The user disabled this URL earlier; the unique index makes the
        // auto-add a no-op, so the match cannot re-enable it.
        await db.insert(schema.chartRepositories).values({
            orgId: org.id,
            url: "https://charts.bitnami.com/bitnami",
            source: "manual",
            enabled: false,
        });

        const stats = await attribution.runAttributionPass();
        expect(stats.reposAutoAdded).toBe(0);

        const [row] = await db
            .select()
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.orgId, org.id));
        expect(row).toMatchObject({ source: "manual", enabled: false });
        // The attribution itself is still written — repo resolution does not
        // depend on the repositories table.
        expect(await attributionRows(org.id)).toHaveLength(1);
    });

    it("attributes OCI-hosted charts without creating a repository row", async () => {
        const db = getTestDb();
        const { attribution } = await modules();

        // OCI repos serve no index.yaml; the mirror is their version source.
        await db.insert(schema.artifactHubPackages).values({
            name: "oci-chart",
            repoName: "oci-repo",
            repoUrl: "oci://registry.example.com/charts",
            versions: [{ pkg: "3.1.0", app: "3.1.0", kube: null, deprecated: false }],
            lastSeenAt: new Date(),
        });

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "oci-chart",
            chartVersion: "3.1.0",
        });

        const stats = await attribution.runAttributionPass();
        expect(stats).toMatchObject({ attributionsWritten: 1, reposAutoAdded: 0 });

        expect(await attributionRows(org.id)).toHaveLength(1);
        const repos = await db
            .select()
            .from(schema.chartRepositories)
            .where(eq(schema.chartRepositories.orgId, org.id));
        expect(repos).toHaveLength(0);
    });

    it("keeps orgs isolated: one org's installs never attribute another's charts", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const orgA = await createOrganization(db);
        const orgB = await createOrganization(db);
        const clusterA = await createCluster(db, orgA.id);
        const clusterB = await createCluster(db, orgB.id);

        await createHelmRelease(db, orgA.id, clusterA.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
        });
        await createHelmRelease(db, orgB.id, clusterB.id, {
            chartName: "postgresql",
            chartVersion: "0.9.2",
            appVersion: "17.5",
        });

        await attribution.runAttributionPass();

        const a = await attributionRows(orgA.id);
        const b = await attributionRows(orgB.id);
        expect(a.map((r) => r.chartName)).toEqual(["redis"]);
        expect(b.map((r) => r.chartName)).toEqual(["postgresql"]);
        expect(b[0]).toMatchObject({ repoUrl: "https://jouve.github.io/charts/" });

        // Auto-add is per-org too.
        const reposB = await db
            .select()
            .from(schema.chartRepositories)
            .where(
                and(
                    eq(schema.chartRepositories.orgId, orgB.id),
                    eq(schema.chartRepositories.source, "artifact-hub-matched")
                )
            );
        expect(reposB.map((r) => r.url)).toEqual(["https://jouve.github.io/charts/"]);
    });

    it("forces one answer per (org, chart): conflicting installs refuse", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        // 28.0.5 is bitnami-only; 2.4.6 is groundhog2k-only. Two winners for
        // one (org, chart) key — the unique constraint forces a refusal.
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
            namespace: "ns-a",
        });
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "2.4.6",
            namespace: "ns-b",
        });

        const stats = await attribution.runAttributionPass();
        expect(stats).toMatchObject({ chartsExamined: 1, attributionsWritten: 0, attributionsRefused: 1 });
        expect(await attributionRows(org.id)).toHaveLength(0);
    });

    it("records the pass counters on the sync state row", async () => {
        const db = getTestDb();
        const { attribution, repo } = await modules();
        await seedMirror(repo);

        const org = await createOrganization(db);
        const cluster = await createCluster(db, org.id);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "redis",
            chartVersion: "28.0.5",
        });

        const stats = await attribution.runAttributionPass();
        await repo.createArtifactHubSyncRepository().recordAttributionStats(stats);

        const [state] = await db.select().from(schema.artifactHubSyncState);
        expect(state).toMatchObject({
            chartsExamined: 1,
            attributionsWritten: 1,
            attributionsRefused: 0,
            reposAutoAdded: 1,
        });
    });
});
