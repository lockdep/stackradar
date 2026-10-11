/**
 * The severity fill (`osv-sync/severity-fill.ts`), against a real database.
 *
 * The case it exists for: a Go binary matches `GO-2026-4918`, which the Go
 * vuln DB publishes without CVSS, and the finding is reported as
 * `CVE-2026-33814`, whose other records all say 7.5. Everything else here is
 * one of the rules that keeps the lending honest: own severity wins, the
 * lender is chosen deterministically, a copy is re-derived when anything
 * behind it moves.
 *
 * Dynamic imports so `db/index.ts` initialises after test setup has set
 * DATABASE_URL.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import type { NewVulnerability } from "../../../src/db/schema/vulnerabilities.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

type Fill = typeof import("../../../src/osv-sync/severity-fill.js").fillInheritedSeverity;
type VulnMirrorRepository = typeof import("../../../src/repositories/index.js").vulnerabilityMirrorRepository;

let fillInheritedSeverity: Fill;
let vulnerabilityMirrorRepository: VulnMirrorRepository;

beforeAll(async () => {
    fillInheritedSeverity = (await import("../../../src/osv-sync/severity-fill.js")).fillInheritedSeverity;
    vulnerabilityMirrorRepository = (await import("../../../src/repositories/index.js")).vulnerabilityMirrorRepository;
    await cleanAllData();
});

type Seed = {
    vulnId: string;
    aliases?: string[];
    severityLevel?: string;
    cvssScore?: number | null;
    withdrawnAt?: Date | null;
};

async function seed(rows: Seed[]) {
    await getTestDb()
        .insert(schema.vulnerabilities)
        .values(
            withFindingIdentity(
                rows.map((r) => ({
                    source: "osv",
                    aliases: [],
                    severityLevel: "unknown",
                    cvssScore: null,
                    ...r,
                })),
            ),
        );
}

async function row(vulnId: string) {
    const [found] = await getTestDb()
        .select({
            severityLevel: schema.vulnerabilities.severityLevel,
            cvssScore: schema.vulnerabilities.cvssScore,
            severitySource: schema.vulnerabilities.severitySource,
            riskScore: schema.vulnerabilities.riskScore,
        })
        .from(schema.vulnerabilities)
        .where(eq(schema.vulnerabilities.vulnId, vulnId));
    return found!;
}

/** What the OSV sync writes for a record, as `convertOsvRecordToVulnerability` shapes it. */
function synced(
    vulnId: string,
    aliases: string[],
    own: { severityLevel: string; cvssScore: number | null },
    hash: string,
): NewVulnerability {
    return withFindingIdentity([
        {
            vulnId,
            source: "osv",
            schemaVersion: "1.7.0",
            severity: [],
            aliases,
            related: [],
            references: [],
            credits: [],
            modifiedAt: new Date("2026-09-01T00:00:00Z"),
            rawData: { id: vulnId },
            rawHash: Buffer.from(hash.padEnd(32, "x")),
            ...own,
        },
    ])[0]!;
}

describe("fillInheritedSeverity", () => {
    beforeEach(async () => {
        await getTestDb().execute(sql`DELETE FROM vulnerabilities`);
    });

    it("lends an unscored ecosystem advisory the CVSS of its CVE, and says where it came from", async () => {
        await seed([
            { vulnId: "GO-2026-4918", aliases: ["CVE-2026-33814", "BIT-golang-2026-33814"] },
            { vulnId: "CVE-2026-33814", aliases: ["GO-2026-4918"], severityLevel: "high", cvssScore: 7.5 },
            { vulnId: "DEBIAN-CVE-2026-33814", aliases: ["CVE-2026-33814"], severityLevel: "high", cvssScore: 7.5 },
        ]);
        const before = await row("GO-2026-4918");

        await fillInheritedSeverity("all");

        const go = await row("GO-2026-4918");
        expect(go).toMatchObject({ severityLevel: "high", cvssScore: 7.5, severitySource: "CVE-2026-33814" });
        // The generated risk column follows the columns it is computed from.
        expect(go.riskScore!).toBeGreaterThan(before.riskScore!);
        // Lenders keep their own values and are not marked as borrowers.
        expect(await row("CVE-2026-33814")).toMatchObject({ cvssScore: 7.5, severitySource: null });
    });

    it("never overrides a record's own severity, even a label without a score", async () => {
        await seed([
            { vulnId: "CVE-2026-1000", severityLevel: "critical", cvssScore: 9.8 },
            { vulnId: "UBUNTU-CVE-2026-1000", aliases: ["CVE-2026-1000"], severityLevel: "medium", cvssScore: null },
        ]);

        await fillInheritedSeverity("all");

        expect(await row("UBUNTU-CVE-2026-1000")).toMatchObject({
            severityLevel: "medium",
            cvssScore: null,
            severitySource: null,
        });
    });

    it("prefers the CVE record's score, and falls back to the highest when the CVE record has none", async () => {
        await seed([
            // The CVE record scores lower than the GHSA; it still lends.
            { vulnId: "GO-2026-0001", aliases: ["CVE-2026-2000"] },
            { vulnId: "CVE-2026-2000", severityLevel: "high", cvssScore: 7.5 },
            { vulnId: "GHSA-aaaa-bbbb-cccc", aliases: ["CVE-2026-2000"], severityLevel: "critical", cvssScore: 9.8 },
            // A CVE record without a score: the best-scored sibling lends.
            { vulnId: "GO-2026-0002", aliases: ["CVE-2026-3000"] },
            { vulnId: "CVE-2026-3000" },
            { vulnId: "GHSA-dddd-eeee-ffff", aliases: ["CVE-2026-3000"], severityLevel: "medium", cvssScore: 5.3 },
            { vulnId: "BIT-thing-2026-3000", aliases: ["CVE-2026-3000"], severityLevel: "high", cvssScore: 8.1 },
        ]);

        await fillInheritedSeverity("all");

        expect(await row("GO-2026-0001")).toMatchObject({ cvssScore: 7.5, severitySource: "CVE-2026-2000" });
        expect(await row("GO-2026-0002")).toMatchObject({ cvssScore: 8.1, severitySource: "BIT-thing-2026-3000" });
        expect(await row("CVE-2026-3000")).toMatchObject({ cvssScore: 8.1, severitySource: "BIT-thing-2026-3000" });
    });

    it("never borrows a placeholder score", async () => {
        await seed([
            { vulnId: "GO-2026-5039", aliases: ["CVE-2026-42507"] },
            // Cleanstart's one-vector-fits-all 9.8, against the distros' real 5.3.
            {
                vulnId: "CLEANSTART-2026-BX08713",
                aliases: ["CVE-2026-42507"],
                severityLevel: "critical",
                cvssScore: 9.8,
            },
            { vulnId: "UBUNTU-CVE-2026-42507", aliases: ["CVE-2026-42507"], severityLevel: "medium", cvssScore: 5.3 },
            // Nobody but Cleanstart: stays unscored rather than critical.
            { vulnId: "GO-2026-5038", aliases: ["CVE-2026-42506"] },
            {
                vulnId: "CLEANSTART-2026-ES62774",
                aliases: ["CVE-2026-42506"],
                severityLevel: "critical",
                cvssScore: 9.8,
            },
        ]);

        await fillInheritedSeverity("all");

        expect(await row("GO-2026-5039")).toMatchObject({ cvssScore: 5.3, severitySource: "UBUNTU-CVE-2026-42507" });
        expect(await row("GO-2026-5038")).toMatchObject({
            severityLevel: "unknown",
            cvssScore: null,
            severitySource: null,
        });
        // Cleanstart's own record keeps what it publishes.
        expect(await row("CLEANSTART-2026-ES62774")).toMatchObject({ cvssScore: 9.8, severitySource: null });
    });

    it("ignores withdrawn lenders, and a record alone in its identity finds none", async () => {
        await seed([
            { vulnId: "GO-2026-0003", aliases: ["CVE-2026-4000"] },
            { vulnId: "CVE-2026-4000", severityLevel: "high", cvssScore: 7.5, withdrawnAt: new Date("2026-09-01") },
            // No CVE and no GHSA: identity `#GO-2026-0005`, nobody to borrow from.
            { vulnId: "GO-2026-0005" },
        ]);

        await fillInheritedSeverity("all");

        expect(await row("GO-2026-0003")).toMatchObject({
            severityLevel: "unknown",
            cvssScore: null,
            severitySource: null,
        });
        expect(await row("GO-2026-0005")).toMatchObject({
            severityLevel: "unknown",
            cvssScore: null,
            severitySource: null,
        });
    });

    it("lends within a GHSA identity when there is no CVE", async () => {
        await seed([
            // Both `#GHSA-gggg-hhhh-iiii` (`soleGhsaIdentity`).
            { vulnId: "GO-2026-0004", aliases: ["GHSA-gggg-hhhh-iiii"] },
            { vulnId: "GHSA-gggg-hhhh-iiii", aliases: ["GO-2026-0004"], severityLevel: "high", cvssScore: 7.5 },
        ]);

        await fillInheritedSeverity({ vulnIds: ["GHSA-gggg-hhhh-iiii"] });

        expect(await row("GO-2026-0004")).toMatchObject({
            severityLevel: "high",
            cvssScore: 7.5,
            severitySource: "GHSA-gggg-hhhh-iiii",
        });
    });

    it("re-derives a borrowed score when the sync restates either side", async () => {
        await vulnerabilityMirrorRepository.bulkUpsertFromSync([
            synced("GO-2026-5000", ["CVE-2026-5000"], { severityLevel: "unknown", cvssScore: null }, "go-1"),
            synced("CVE-2026-5000", [], { severityLevel: "high", cvssScore: 7.5 }, "cve-1"),
        ]);
        await fillInheritedSeverity({ vulnIds: ["GO-2026-5000", "CVE-2026-5000"] });
        expect(await row("GO-2026-5000")).toMatchObject({ cvssScore: 7.5, severitySource: "CVE-2026-5000" });

        // The lender is rescored: only the lender changed, and the borrower follows.
        await vulnerabilityMirrorRepository.bulkUpsertFromSync([
            synced("CVE-2026-5000", [], { severityLevel: "critical", cvssScore: 9.1 }, "cve-2"),
        ]);
        await fillInheritedSeverity({ vulnIds: ["CVE-2026-5000"] });
        expect(await row("GO-2026-5000")).toMatchObject({ severityLevel: "critical", cvssScore: 9.1 });

        // The borrower starts publishing its own score: the upsert restates it and it stops borrowing.
        await vulnerabilityMirrorRepository.bulkUpsertFromSync([
            synced("GO-2026-5000", ["CVE-2026-5000"], { severityLevel: "medium", cvssScore: 5.9 }, "go-2"),
        ]);
        expect(await row("GO-2026-5000")).toMatchObject({
            severityLevel: "medium",
            cvssScore: 5.9,
            severitySource: null,
        });
        await fillInheritedSeverity({ vulnIds: ["GO-2026-5000"] });
        expect(await row("GO-2026-5000")).toMatchObject({ cvssScore: 5.9, severitySource: null });
    });

    it("takes the score back when the lender leaves the identity", async () => {
        await seed([
            { vulnId: "GO-2026-6000", aliases: ["CVE-2026-6000"] },
            { vulnId: "GHSA-jjjj-kkkk-llll", aliases: ["CVE-2026-6000"], severityLevel: "high", cvssScore: 7.5 },
        ]);
        await fillInheritedSeverity("all");
        expect(await row("GO-2026-6000")).toMatchObject({ severitySource: "GHSA-jjjj-kkkk-llll" });

        // The GHSA drops its CVE alias: it is now `#GHSA-…`, and the only
        // route from the change back to the borrower is `severity_source`.
        await vulnerabilityMirrorRepository.bulkUpsertFromSync([
            synced("GHSA-jjjj-kkkk-llll", [], { severityLevel: "high", cvssScore: 7.5 }, "ghsa-2"),
        ]);
        await fillInheritedSeverity({ vulnIds: ["GHSA-jjjj-kkkk-llll"] });

        expect(await row("GO-2026-6000")).toMatchObject({
            severityLevel: "unknown",
            cvssScore: null,
            severitySource: null,
        });
    });
});
