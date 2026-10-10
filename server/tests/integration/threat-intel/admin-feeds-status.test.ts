/**
 * The admin Feeds tab's payload: one status block per daily feed sync
 * (EPSS, KEV, Artifact Hub).
 *
 * The properties worth pinning are the ones the UI leans on rather than the
 * projection itself:
 *
 * - an empty database reads as "never synced" (null state, stale) rather than
 *   as an error or as fresh;
 * - `stale` is computed against `FEED_STALE_AFTER_HOURS`, on the same side of
 *   the threshold as `isFeedStale()` — the CLIs use that helper directly, and
 *   the two surfaces must not disagree;
 * - a failed run surfaces `lastError` *and* an untouched `lastSyncedAt`,
 *   because `recordFailure()` deliberately leaves the freshness stamp alone;
 * - the advisory/mirror counts are live column counts, not echoes of the last
 *   run's counters.
 *
 * The repository is imported dynamically: `src/db/index.ts` reads DATABASE_URL
 * at module load, and test-setup.ts only sets it in its own beforeAll.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import { seedTestScenario, withFindingIdentity, type SeedTestScenarioResult } from "../../fixtures/seed-data.js";
import * as schema from "../../../src/db/schema/index.js";
import { FEED_STALE_AFTER_HOURS } from "../../../src/lib/feed-health.js";

let adminRepository: typeof import("../../../src/repositories/admin.repository.js").adminRepository;
let testData: SeedTestScenarioResult;

beforeAll(async () => {
    adminRepository = (await import("../../../src/repositories/admin.repository.js")).adminRepository;
});

beforeEach(async () => {
    await cleanAllData();
    testData = await seedTestScenario(getTestDb());
});

const HOUR = 3600_000;

function hoursAgo(h: number): Date {
    return new Date(Date.now() - h * HOUR);
}

describe("feeds status on an empty database", () => {
    it("reads as never-synced rather than as an error", async () => {
        const feeds = await adminRepository.getFeedsStatus();

        expect(feeds.staleAfterHours).toBe(FEED_STALE_AFTER_HOURS);
        for (const feed of [feeds.epss, feeds.kev, feeds.artifactHub]) {
            expect(feed.state).toBeNull();
            // Stale, not fresh: a feed that has never run must not render green.
            expect(feed.stale).toBe(true);
        }
        expect(feeds.epss.advisoriesWithScore).toBe(0);
        expect(feeds.kev.advisoriesListed).toBe(0);
        expect(feeds.artifactHub.mirrorPackages).toBe(0);
        expect(feeds.artifactHub.attributions).toBe(0);
    });
});

describe("feeds status staleness", () => {
    it("marks a feed fresh inside the threshold and stale outside it", async () => {
        await getTestDb().insert(schema.epssSyncState).values({
            lastSyncedAt: hoursAgo(1),
            lastScoreDate: "2026-08-16",
        });
        await getTestDb().insert(schema.kevSyncState).values({
            lastSyncedAt: hoursAgo(FEED_STALE_AFTER_HOURS + 1),
            catalogVersion: "2026.08.14",
        });

        const feeds = await adminRepository.getFeedsStatus();

        expect(feeds.epss.stale).toBe(false);
        expect(feeds.epss.state?.lastScoreDate).toBe("2026-08-16");
        expect(feeds.kev.stale).toBe(true);
        expect(feeds.kev.state?.catalogVersion).toBe("2026.08.14");
    });

    it("keeps a failed attempt and a fresh stamp visible at the same time", async () => {
        // recordFailure() never touches lastSyncedAt, so this is the shape a
        // failed nightly run actually leaves behind: yesterday's data still
        // fresh, last night's error on record. Both must survive the payload —
        // collapsing either would report "broken" or "all fine", and neither
        // is what happened.
        await getTestDb().insert(schema.artifactHubSyncState).values({
            lastSyncedAt: hoursAgo(20),
            packagesInDump: 12404,
            packagesApplied: 12400,
            lastError: "dump download failed: 503",
        });

        const feeds = await adminRepository.getFeedsStatus();

        expect(feeds.artifactHub.stale).toBe(false);
        expect(feeds.artifactHub.state?.lastError).toBe("dump download failed: 503");
        expect(feeds.artifactHub.state?.packagesApplied).toBe(12400);
    });
});

describe("feeds status live counts", () => {
    it("counts decorated advisories from the columns, not the state row", async () => {
        const db = getTestDb();
        await db.insert(schema.vulnerabilities).values(withFindingIdentity([
            { vulnId: "CVE-2021-44228", source: "osv", aliases: [], epssScore: 0.97, epssPercentile: 0.999, kevListedAt: new Date() },
            { vulnId: "GHSA-scored-only-xxxx", source: "osv", aliases: [], epssScore: 0.1, epssPercentile: 0.5 },
            { vulnId: "GHSA-undecorated-xxxx", source: "osv", aliases: [] },
        ]));
        // State row counters say something else on purpose — the live counts
        // must come from the vulnerabilities columns.
        await db.insert(schema.epssSyncState).values({ lastSyncedAt: new Date(), rowsMatched: 999 });

        const feeds = await adminRepository.getFeedsStatus();

        expect(feeds.epss.advisoriesWithScore).toBe(2);
        expect(feeds.kev.advisoriesListed).toBe(1);
    });

    it("counts the mirror and attributions as they are now", async () => {
        const db = getTestDb();
        const [pkg] = await db.insert(schema.artifactHubPackages).values([
            { name: "postgresql", repoName: "bitnami", repoUrl: "https://charts.bitnami.com/bitnami", versions: [], lastSeenAt: new Date() },
            { name: "postgresql", repoName: "other", repoUrl: "https://example.com/charts", versions: [], lastSeenAt: new Date() },
        ]).returning();
        await db.insert(schema.chartAttributions).values({
            orgId: testData.org.id,
            chartName: "postgresql",
            packageId: pkg!.id,
            repoUrl: pkg!.repoUrl,
            evidence: {},
            matchedAt: new Date(),
        });

        const feeds = await adminRepository.getFeedsStatus();

        expect(feeds.artifactHub.mirrorPackages).toBe(2);
        expect(feeds.artifactHub.attributions).toBe(1);
    });
});
