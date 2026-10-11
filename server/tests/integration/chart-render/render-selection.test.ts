/**
 * Which candidate chart versions the nightly pass selects and enqueues —
 * the chart-render pipeline.
 *
 * The rules under test: the union of {newest, newest-within-current-major}
 * per trailing chart; only publicly fetchable repos; versions already
 * attempted (rendered *or* failed) never reselected; job params carry no
 * tenant data; open jobs are not duplicated.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, createHelmRelease } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import type { ChartRepoVersion } from "../../../src/db/schema/chart-repositories.js";

const REPO_URL = "https://charts.example.com";

async function selection() {
    return import("../../../src/chart-render/selection.js");
}

function v(version: string, tarball = true): ChartRepoVersion {
    return {
        version,
        appVersion: null,
        tarballUrl: tarball ? `${REPO_URL}/app-${version}.tgz` : null,
    };
}

async function seedRepoWithEntries(
    orgId: string,
    versions: ChartRepoVersion[],
    opts: { chartName?: string; username?: string | null; password?: string | null } = {},
) {
    const db = getTestDb();
    const [repo] = await db
        .insert(schema.chartRepositories)
        .values({
            orgId,
            url: REPO_URL,
            source: "observed",
            enabled: true,
            username: opts.username ?? null,
            password: opts.password ?? null,
        })
        .returning();
    await db.insert(schema.chartRepoEntries).values({
        repositoryId: repo!.id,
        chartName: opts.chartName ?? "app",
        versions,
        fetchedAt: new Date(),
    });
    return repo!;
}

describe("selectRenderCandidates", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("selects the newest version and the newest within the release's major", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "app",
            chartVersion: "58.7.0",
            repoUrl: REPO_URL,
        });
        await seedRepoWithEntries(org.id, [v("61.2.0"), v("58.9.0"), v("58.8.0"), v("57.0.0")]);

        const { selectRenderCandidates } = await selection();
        const candidates = await selectRenderCandidates(10);

        expect(candidates.map((c) => c.chartVersion).sort()).toEqual(["58.9.0", "61.2.0"]);
        for (const candidate of candidates) {
            expect(candidate).toMatchObject({ repoUrl: REPO_URL, chartName: "app" });
            expect(candidate.tarballUrl).toContain(".tgz");
        }
    });

    it("skips versions without a tarball URL and versions already attempted", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "app",
            chartVersion: "1.0.0",
            repoUrl: REPO_URL,
        });
        await seedRepoWithEntries(org.id, [v("1.3.0", false), v("1.2.0"), v("1.1.0")]);

        // 1.2.0 failed once — a failed render is never retried nightly.
        await db.insert(schema.chartRenders).values({
            repoUrl: REPO_URL,
            chartName: "app",
            chartVersion: "1.2.0",
            status: "render_failed",
            failureReason: "tarball exceeded the ceiling",
            renderedAt: new Date(),
        });

        const { selectRenderCandidates } = await selection();
        const candidates = await selectRenderCandidates(10);
        // 1.3.0 has no tarball, 1.2.0 was attempted; 1.1.0 is what remains —
        // but it is only selected if it is newest-in-major or newest, and with
        // 1.3.0 unfetchable and 1.2.0 attempted, nothing new remains: the
        // per-release picks were 1.3.0 (newest, no tarball) and 1.3.0
        // (newest-in-major, same). Nothing renderable is selected.
        expect(candidates).toEqual([]);
    });

    it("never selects from a repository the org reads with credentials", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "app",
            chartVersion: "1.0.0",
            repoUrl: REPO_URL,
        });
        await seedRepoWithEntries(org.id, [v("1.1.0")], { username: "svc", password: "secret" });

        const { selectRenderCandidates } = await selection();
        expect(await selectRenderCandidates(10)).toEqual([]);
    });
});

describe("enqueueCandidateRenders", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("enqueues chart_render jobs under the platform org with tenant-free params", async () => {
        const db = getTestDb();
        const { org, cluster } = await seedTestScenario(db);
        await createHelmRelease(db, org.id, cluster.id, {
            chartName: "app",
            chartVersion: "1.0.0",
            repoUrl: REPO_URL,
        });
        await seedRepoWithEntries(org.id, [v("1.1.0")]);

        const { enqueueCandidateRenders } = await selection();
        const stats = await enqueueCandidateRenders();
        expect(stats).toMatchObject({ selected: 1, enqueued: 1, alreadyQueued: 0 });

        const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, "chart_render"));
        expect(jobs).toHaveLength(1);

        // The job lives under the platform org, not the tenant's…
        const { findPlatform } = await import("../../../src/services/platform.service.js");
        const platform = await findPlatform();
        expect(jobs[0]!.orgId).toBe(platform!.orgId);
        expect(jobs[0]!.orgId).not.toBe(org.id);

        // …and its params name only the public chart identity.
        expect(jobs[0]!.params).toEqual({
            repoUrl: REPO_URL,
            chartName: "app",
            chartVersion: "1.1.0",
            tarballUrl: `${REPO_URL}/app-1.1.0.tgz`,
            kubeRange: null,
        });

        // A second pass finds the job still open and does not duplicate it.
        const again = await enqueueCandidateRenders();
        expect(again).toMatchObject({ enqueued: 0, alreadyQueued: 1 });
        const after = await db
            .select()
            .from(schema.jobs)
            .where(and(eq(schema.jobs.type, "chart_render"), eq(schema.jobs.status, "pending")));
        expect(after).toHaveLength(1);
    });
});

describe("enqueueMissingPlatformScans", () => {
    beforeEach(async () => {
        await cleanAllData();
    });

    it("sweeps resolved-but-unscanned digests once, skipping open jobs and off-list registries", async () => {
        const db = getTestDb();
        const digest = "sha256:" + "9".repeat(64);
        await db.insert(schema.chartImageObservations).values([
            {
                repoUrl: REPO_URL,
                chartName: "app",
                chartVersion: "1.1.0",
                imageRef: "quay.io/acme/app:1.1.0",
                registry: "quay.io",
                repository: "acme/app",
                tag: "1.1.0",
                digest,
            },
            {
                // Unresolved — measures nothing, must not be swept.
                repoUrl: REPO_URL,
                chartName: "app",
                chartVersion: "1.1.0",
                imageRef: "registry.internal.corp/acme/x:1",
                registry: "registry.internal.corp",
                repository: "acme/x",
                tag: "1",
                digest: null,
                resolutionError: "registry registry.internal.corp is not on the public allowlist",
            },
        ]);

        const { enqueueMissingPlatformScans } = await import("../../../src/platform-scan/scan-job.js");
        expect(await enqueueMissingPlatformScans()).toBe(1);

        const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, "platform_scan"));
        expect(jobs).toHaveLength(1);
        expect(jobs[0]!.params).toEqual({ digest, registry: "quay.io", repository: "acme/app" });

        // The open job covers the digest — the sweep does not double-queue.
        expect(await enqueueMissingPlatformScans()).toBe(0);
    });
});
