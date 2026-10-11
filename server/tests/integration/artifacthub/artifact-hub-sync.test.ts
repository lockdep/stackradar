/**
 * The Artifact Hub sync, against a real database and a stubbed dump.
 *
 * Same split as the EPSS sync test: the download is a fetch and a JSON.parse,
 * and the parts worth testing — stamp-and-prune, the short-dump refusal, the
 * freshness guard, the advisory lock — are SQL or transaction semantics.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { getTestDb, getTestPgClient, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { loadConfig, type ArtifactHubSyncConfig } from "../../../src/artifacthub-sync/config.js";

type Repo = typeof import("../../../src/artifacthub-sync/repository.js");
type Worker = typeof import("../../../src/artifacthub-sync/worker.js");

async function modules(): Promise<{ repo: Repo; worker: Worker }> {
    return {
        repo: await import("../../../src/artifacthub-sync/repository.js"),
        worker: await import("../../../src/artifacthub-sync/worker.js"),
    };
}

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/artifact-hub/nova-slice.json");
const fixture = (): unknown[] => JSON.parse(readFileSync(fixturePath, "utf-8"));

/** A stub downloader serving an already-parsed dump. */
function stubDump(dump: unknown) {
    return { fetchDump: async () => dump };
}

/**
 * Config is loaded lazily, inside the tests: `databaseUrl` feeds the advisory
 * lock's dedicated connection, and `DATABASE_URL` points at the container
 * only after the per-file setup has run.
 */
function testConfig(overrides: Partial<ArtifactHubSyncConfig> = {}): ArtifactHubSyncConfig {
    return { ...loadConfig(), minPackagesToApply: 5, minSyncIntervalHours: 23, ...overrides };
}

describe("Artifact Hub sync", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        const db = getTestDb();
        await db.delete(schema.chartAttributions);
        await db.delete(schema.artifactHubPackages);
        await db.delete(schema.artifactHubSyncState);
    });

    it("applies the dump to the mirror", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const w = worker.createArtifactHubSyncWorker(
            testConfig(),
            stubDump(fixture()),
            repo.createArtifactHubSyncRepository(),
        );

        const result = await w.runOnce();
        expect(result.skipped).toBe(false);
        expect(result.packagesInDump).toBe(10);
        expect(result.packagesApplied).toBe(10);

        const rows = await db.select().from(schema.artifactHubPackages);
        expect(rows).toHaveLength(10);

        const bitnamiRedis = rows.find((r) => r.repoName === "bitnami" && r.name === "redis")!;
        expect(bitnamiRedis.repoUrl).toBe("https://charts.bitnami.com/bitnami");
        expect(bitnamiRedis.repoVerified).toBe(true);
        expect(bitnamiRedis.stars).toBe(511);
        expect(bitnamiRedis.versions.some((v) => v.pkg === "19.3.0")).toBe(true);

        const [state] = await db.select().from(schema.artifactHubSyncState);
        expect(state?.lastSyncedAt).not.toBeNull();
        expect(state?.packagesApplied).toBe(10);
        expect(state?.lastError).toBeNull();
    });

    it("prunes packages the next dump no longer mentions", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const r = repo.createArtifactHubSyncRepository();
        const config = testConfig({ minSyncIntervalHours: 0 });

        await worker.createArtifactHubSyncWorker(config, stubDump(fixture()), r).runOnce();

        // Second dump: groundhog2k/redis is gone, bitnami/redis got new stars.
        const second = fixture().filter(
            (p) => (p as { repository: { name: string } }).repository.name !== "groundhog2k",
        );
        (second.find((p) => (p as { name: string }).name === "redis") as { stars: number }).stars = 600;

        const result = await worker.createArtifactHubSyncWorker(config, stubDump(second), r).runOnce();
        expect(result.packagesApplied).toBe(9);
        expect(result.packagesPruned).toBe(1);

        const rows = await db.select().from(schema.artifactHubPackages);
        expect(rows).toHaveLength(9);
        expect(rows.find((x) => x.repoName === "groundhog2k")).toBeUndefined();
        expect(rows.find((x) => x.repoName === "bitnami" && x.name === "redis")!.stars).toBe(600);
    });

    it("refuses a short dump and leaves the prior mirror intact", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const r = repo.createArtifactHubSyncRepository();
        const config = testConfig({ minSyncIntervalHours: 0 });

        await worker.createArtifactHubSyncWorker(config, stubDump(fixture()), r).runOnce();
        const [before] = await db.select().from(schema.artifactHubSyncState);

        await expect(
            worker.createArtifactHubSyncWorker(config, stubDump(fixture().slice(0, 2)), r).runOnce(),
        ).rejects.toThrow(/below the 5 floor/);

        // The mirror still holds the full prior dump — a truncated dump would
        // prune live rows and cascade their attributions, so nothing applies.
        const rows = await db.select().from(schema.artifactHubPackages);
        expect(rows).toHaveLength(10);

        // …and the failure is recorded without advancing the freshness clock.
        const [state] = await db.select().from(schema.artifactHubSyncState);
        expect(state?.lastError).toMatch(/floor/);
        expect(state?.lastSyncedAt?.getTime()).toBe(before!.lastSyncedAt?.getTime());
    });

    it("records a first-run failure without setting lastSyncedAt", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();

        await expect(
            worker
                .createArtifactHubSyncWorker(
                    testConfig(),
                    {
                        fetchDump: async () => {
                            throw new Error("boom from the CDN");
                        },
                    },
                    repo.createArtifactHubSyncRepository(),
                )
                .runOnce(),
        ).rejects.toThrow(/boom from the CDN/);

        const [state] = await db.select().from(schema.artifactHubSyncState);
        expect(state?.lastError).toMatch(/boom/);
        expect(state?.lastSyncedAt).toBeNull();
    });

    it("skips a re-run inside the freshness window, and honours --force", async () => {
        const { repo, worker } = await modules();
        const r = repo.createArtifactHubSyncRepository();
        const config = testConfig();
        const feed = stubDump(fixture());

        expect((await worker.createArtifactHubSyncWorker(config, feed, r).runOnce()).skipped).toBe(false);
        // The mirror refresh is skipped; the attribution pass still runs —
        // the inventory moves on every scanner report.
        const second = await worker.createArtifactHubSyncWorker(config, feed, r).runOnce();
        expect(second).toMatchObject({ skipped: true, reason: "fresh" });
        expect(second.attribution).toBeDefined();
        expect((await worker.createArtifactHubSyncWorker(config, feed, r).runOnce({ force: true })).skipped).toBe(
            false,
        );
    });

    it("skips when another run holds the advisory lock", async () => {
        const { repo, worker } = await modules();
        const config = testConfig();

        // Hold the lock from a reserved connection, as a concurrent run would.
        const pgClient = getTestPgClient();
        const reserved = await pgClient.reserve();
        try {
            const [row] = await reserved<[{ locked: boolean }]>`
                SELECT pg_try_advisory_lock(${config.advisoryLockId}) AS locked
            `;
            expect(row?.locked).toBe(true);

            const result = await worker
                .createArtifactHubSyncWorker(config, stubDump(fixture()), repo.createArtifactHubSyncRepository())
                .runOnce();
            expect(result).toEqual({ skipped: true, reason: "locked" });
        } finally {
            await reserved`SELECT pg_advisory_unlock(${config.advisoryLockId})`;
            reserved.release();
        }
    });

    it("keeps the mirror global — no org scoping anywhere", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        await worker
            .createArtifactHubSyncWorker(testConfig(), stubDump(fixture()), repo.createArtifactHubSyncRepository())
            .runOnce();

        // The natural key is (repo_name, name); the same chart name from two
        // repositories is two rows, which is what attribution scores over.
        const redisRows = await db
            .select()
            .from(schema.artifactHubPackages)
            .where(
                and(eq(schema.artifactHubPackages.name, "redis"), eq(schema.artifactHubPackages.repoVerified, true)),
            );
        expect(redisRows.map((r) => r.repoName).sort()).toEqual(["bitnami", "vks-helm-charts"]);
    });
});
