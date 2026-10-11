/**
 * The EPSS sync, against a real database and a stubbed feed.
 *
 * The feed is stubbed and the database is not, which is the right split: the
 * download is a `fetch` and a gunzip, and the parts worth testing are the two
 * join paths, the freshness guard, and the short-file refusal — all of which
 * are SQL or transaction semantics.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTestDb, getTestPgClient, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { EPSS_APPLY_LOCK_KEY, loadConfig } from "../../../src/epss-sync/config.js";
import { parseHeader, parseRow } from "../../../src/epss-sync/parser.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

type Repo = typeof import("../../../src/epss-sync/repository.js");
type Worker = typeof import("../../../src/epss-sync/worker.js");

async function modules(): Promise<{ repo: Repo; worker: Worker }> {
    return {
        repo: await import("../../../src/epss-sync/repository.js"),
        worker: await import("../../../src/epss-sync/worker.js"),
    };
}

/** A stub feed. Emits the comment header, the column header, then the rows. */
function stubFeed(rows: Array<[string, number, number]>, scoreDate = "2026-08-15") {
    return {
        async *streamLines() {
            yield `#model_version:v2026.06.15,score_date:${scoreDate}T00:00:00+0000`;
            yield "cve,epss,percentile";
            for (const [cve, score, percentile] of rows) {
                yield `${cve},${score},${percentile}`;
            }
        },
    };
}

async function seedAdvisories() {
    const db = getTestDb();
    await db.insert(schema.vulnerabilities).values(
        withFindingIdentity([
            // Direct hit.
            { vulnId: "CVE-2021-44228", source: "osv", cvssScore: 10, severityLevel: "critical", aliases: [] },
            // Alias hit — the npm/Go case that would otherwise go unscored.
            {
                vulnId: "GHSA-jfh8-c2jp-5v3q",
                source: "osv",
                cvssScore: 10,
                severityLevel: "critical",
                aliases: ["CVE-2021-44228"],
            },
            // Two aliases, both scored — must take the more exploited.
            {
                vulnId: "GHSA-multi-alias-xxxx",
                source: "osv",
                cvssScore: 7.5,
                severityLevel: "high",
                aliases: ["CVE-2024-1000", "CVE-2024-2000"],
            },
            // No CVE anywhere. Must stay null.
            { vulnId: "MAL-2024-0001", source: "osv", cvssScore: null, severityLevel: "critical", aliases: [] },
            // A distro tracker record: no aliases, the CVE only under `upstream`.
            {
                vulnId: "UBUNTU-CVE-2021-44228",
                source: "osv",
                cvssScore: 10,
                severityLevel: "critical",
                aliases: [],
                rawData: { upstream: ["CVE-2021-44228"] },
            },
        ]),
    );
}

describe("EPSS sync", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        const db = getTestDb();
        await db.delete(schema.componentVulnerabilities);
        await db.delete(schema.vulnerabilities);
        await db.delete(schema.epssSyncState);
        await seedAdvisories();
    });

    const config = { ...loadConfig(), minRowsToApply: 2, minSyncIntervalHours: 23 };

    it("scores advisories by CVE id and by CVE alias", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const w = worker.createEpssSyncWorker(
            config,
            stubFeed([
                ["CVE-2021-44228", 0.97, 0.999],
                ["CVE-2024-1000", 0.1, 0.9],
                ["CVE-2024-2000", 0.8, 0.99],
            ]),
            repo.createEpssRepository(),
        );

        const result = await w.runOnce();
        expect(result.skipped).toBe(false);
        expect(result.rowsInFile).toBe(3);
        expect(result.scoreDate).toBe("2026-08-15");

        const rows = await db.select().from(schema.vulnerabilities);
        const byId = new Map(rows.map((r) => [r.vulnId, r]));

        expect(byId.get("CVE-2021-44228")!.epssScore).toBeCloseTo(0.97, 4);
        // The alias path is not an optimisation — without it every GHSA finding
        // would rank on CVSS alone while every distro finding ranked on
        // measured exploitation.
        expect(byId.get("GHSA-jfh8-c2jp-5v3q")!.epssScore).toBeCloseTo(0.97, 4);
        // The `upstream` path: distro tracker records carry no aliases at all.
        expect(byId.get("UBUNTU-CVE-2021-44228")!.epssScore).toBeCloseTo(0.97, 4);
        // Two scored aliases: the more exploited wins.
        expect(byId.get("GHSA-multi-alias-xxxx")!.epssScore).toBeCloseTo(0.8, 4);
        // No CVE, no score — and that is the correct value, not a gap.
        expect(byId.get("MAL-2024-0001")!.epssScore).toBeNull();
    });

    it("moves the generated risk score without a second write", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();

        const before = await db
            .select({ risk: schema.vulnerabilities.riskScore })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));

        await worker
            .createEpssSyncWorker(
                config,
                stubFeed([
                    ["CVE-2021-44228", 0.97, 0.999],
                    ["CVE-2024-1000", 0.1, 0.9],
                ]),
                repo.createEpssRepository(),
            )
            .runOnce();

        const after = await db
            .select({ risk: schema.vulnerabilities.riskScore })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));

        // 10.0 CVSS, unscored → 10; with EPSS 0.97 → ~99.
        expect(before[0]!.risk).toBeCloseTo(10, 1);
        expect(after[0]!.risk).toBeGreaterThan(95);
    });

    // Two monolith replicas (`src/topology.ts`) fire the daily cron in the
    // same minute. The apply takes a transaction advisory lock; the one that
    // finds it held skips — no failure recorded, nothing written.
    it("skips, without recording a failure, when another process holds the apply lock", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const holder = await getTestPgClient().reserve();
        try {
            await holder`SELECT pg_advisory_lock(${EPSS_APPLY_LOCK_KEY})`;

            const result = await worker
                .createEpssSyncWorker(
                    config,
                    stubFeed([
                        ["CVE-2021-44228", 0.97, 0.999],
                        ["CVE-2024-1000", 0.1, 0.9],
                    ]),
                    repo.createEpssRepository(),
                )
                .runOnce();

            expect(result).toEqual({ skipped: true, reason: "locked" });
            const [row] = await db
                .select({ epss: schema.vulnerabilities.epssScore })
                .from(schema.vulnerabilities)
                .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));
            expect(row!.epss).toBeNull();
            expect(await repo.createEpssRepository().getState()).toBeUndefined();
        } finally {
            await holder`SELECT pg_advisory_unlock(${EPSS_APPLY_LOCK_KEY})`;
            holder.release();
        }
    });

    it("refuses a truncated feed and rolls the whole run back", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        const strict = { ...config, minRowsToApply: 100 };

        await expect(
            worker
                .createEpssSyncWorker(strict, stubFeed([["CVE-2021-44228", 0.97, 0.999]]), repo.createEpssRepository())
                .runOnce(),
        ).rejects.toThrow(/below the 100 floor/);

        // Nothing applied. A short file is not a partial update — every CVE it
        // omits would have its score blanked, which reorders the product.
        const [row] = await db
            .select({ epss: schema.vulnerabilities.epssScore })
            .from(schema.vulnerabilities)
            .where(eq(schema.vulnerabilities.vulnId, "CVE-2021-44228"));
        expect(row!.epss).toBeNull();

        // …and the failure is recorded without advancing the freshness clock,
        // so the next run is not blocked by the guard.
        const [state] = await db.select().from(schema.epssSyncState);
        expect(state?.lastError).toMatch(/floor/);
        expect(state?.lastSyncedAt).toBeNull();
    });

    it("skips a re-run inside the freshness window, and honours --force", async () => {
        const { repo, worker } = await modules();
        const feed = stubFeed([
            ["CVE-2021-44228", 0.5, 0.9],
            ["CVE-2024-1000", 0.1, 0.8],
        ]);
        const r = repo.createEpssRepository();

        expect((await worker.createEpssSyncWorker(config, feed, r).runOnce()).skipped).toBe(false);
        expect((await worker.createEpssSyncWorker(config, feed, r).runOnce()).skipped).toBe(true);
        expect((await worker.createEpssSyncWorker(config, feed, r).runOnce({ force: true })).skipped).toBe(false);
    });

    it("writes only the advisories whose score actually moved", async () => {
        const { repo, worker } = await modules();
        const r = repo.createEpssRepository();
        const feed = stubFeed([
            ["CVE-2021-44228", 0.5, 0.9],
            ["CVE-2024-1000", 0.1, 0.8],
        ]);
        const forced = { ...config, minSyncIntervalHours: 0 };

        const first = await worker.createEpssSyncWorker(forced, feed, r).runOnce();
        expect(first.advisoriesUpdated).toBeGreaterThan(0);

        // Same file again: every score is already correct, so nothing is
        // rewritten. This is what keeps a daily sync from churning 300k rows.
        const second = await worker.createEpssSyncWorker(forced, feed, r).runOnce();
        expect(second.advisoriesUpdated).toBe(0);
    });

    it("counts unmatched CVEs without claiming they are a fault", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();

        const result = await worker
            .createEpssSyncWorker(
                config,
                stubFeed([
                    ["CVE-2021-44228", 0.97, 0.999],
                    ["CVE-9999-0001", 0.2, 0.5],
                    ["CVE-9999-0002", 0.3, 0.6],
                ]),
                repo.createEpssRepository(),
            )
            .runOnce();

        expect(result.cvesMatched).toBe(1);
        expect(result.cvesUnmatched).toBe(2);

        const [state] = await db.select().from(schema.epssSyncState);
        expect(state?.rowsUnmatched).toBe(2);
        expect(state?.lastError).toBeNull();
    });

    it("leaves the staging tables behind after the transaction", async () => {
        const db = getTestDb();
        const { repo, worker } = await modules();
        await worker
            .createEpssSyncWorker(
                config,
                stubFeed([
                    ["CVE-2021-44228", 0.9, 0.99],
                    ["CVE-2024-1000", 0.1, 0.5],
                ]),
                repo.createEpssRepository(),
            )
            .runOnce();

        // `ON COMMIT DROP` — a leaked temp table would silently poison the next
        // run on the same pooled connection.
        const [row] = await db.execute<{ n: string }>(
            sql`SELECT count(*)::text AS n FROM pg_tables WHERE tablename IN ('epss_staging', 'epss_hits')`,
        );
        expect(Number(row!.n)).toBe(0);
    });
});

describe("EPSS parser", () => {
    it("reads the comment header", () => {
        expect(parseHeader("#model_version:v2023.03.01,score_date:2026-08-15T00:00:00+0000")).toEqual({
            modelVersion: "v2023.03.01",
            scoreDate: "2026-08-15",
        });
    });

    it("rejects the column header, blanks and malformed rows", () => {
        expect(parseRow("cve,epss,percentile")).toBeNull();
        expect(parseRow("")).toBeNull();
        expect(parseRow("#comment")).toBeNull();
        expect(parseRow("NOT-A-CVE,0.1,0.2")).toBeNull();
        expect(parseRow("CVE-2024-1234,notanumber,0.2")).toBeNull();
    });

    it("rejects rather than clamps an out-of-range probability", () => {
        // Out of [0,1] means the file is not what we think it is. Repairing it
        // silently would hide that.
        expect(parseRow("CVE-2024-1234,1.5,0.2")).toBeNull();
        expect(parseRow("CVE-2024-1234,0.5,-0.2")).toBeNull();
    });

    it("upper-cases the CVE for the exact join", () => {
        expect(parseRow("cve-2024-1234,0.5,0.6")?.cve).toBe("CVE-2024-1234");
    });
});
