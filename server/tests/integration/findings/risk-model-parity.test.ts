/**
 * The risk formula in SQL and the risk formula in TypeScript, checked against
 * each other.
 *
 * The same argument as `finding-identity.test.ts`, one layer up. Scoring
 * happens in SQL because it is a generated column — the only way to make a
 * score that cannot outlive its inputs — and in TypeScript because the finding
 * delta compares two in-memory sets and the API returns rollups. Two
 * renderings, one formula, and nothing but this file stopping them drifting.
 *
 * `advisoryRisk` parity is the important half: it is the number stored on
 * 300,000 rows, and a divergence there is invisible until somebody wonders why
 * the API disagrees with `ORDER BY risk_score`.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { getTestDb, cleanAllData } from "../../setup/test-db.js";
import * as schema from "../../../src/db/schema/index.js";
import { advisoryRisk, aggregateRisk } from "../../../src/db/risk-model.js";
import { withFindingIdentity } from "../../fixtures/seed-data.js";

/**
 * Deliberately awkward inputs, not a happy path.
 *
 * Every row here is a shape the mirror actually contains: distro advisories
 * with a band and no vector, `MAL-*` records with neither, GHSA records that
 * only have an EPSS score because of an alias, and the boundary values where a
 * clamp or a `power(0, 1/3)` could disagree between the two languages.
 */
const CASES: Array<{
    vulnId: string;
    cvssScore: number | null;
    severityLevel: string | null;
    epssScore: number | null;
    kevListedAt: Date | null;
}> = [
    {
        vulnId: "CVE-0000-0001",
        cvssScore: 9.8,
        severityLevel: "critical",
        epssScore: 0.94,
        kevListedAt: new Date("2021-12-10"),
    },
    { vulnId: "CVE-0000-0002", cvssScore: 9.8, severityLevel: "critical", epssScore: 0.0004, kevListedAt: null },
    { vulnId: "CVE-0000-0003", cvssScore: 5.3, severityLevel: "medium", epssScore: 0.9, kevListedAt: null },
    { vulnId: "CVE-0000-0004", cvssScore: 2.1, severityLevel: "low", epssScore: 0.0002, kevListedAt: null },
    // No CVSS vector, band only — the distro advisory shape.
    { vulnId: "DSA-0000-1", cvssScore: null, severityLevel: "critical", epssScore: null, kevListedAt: null },
    { vulnId: "DSA-0000-2", cvssScore: null, severityLevel: "HIGH", epssScore: 0.3, kevListedAt: null },
    // Neither. The `MAL-*` shape.
    { vulnId: "MAL-0000-1", cvssScore: null, severityLevel: null, epssScore: null, kevListedAt: null },
    // Unknown band spelling — must fall to the same default as no band at all.
    { vulnId: "OSV-0000-1", cvssScore: null, severityLevel: "moderate", epssScore: null, kevListedAt: null },
    // Boundaries: zero, one, and the maximum score.
    { vulnId: "CVE-0000-0005", cvssScore: 0, severityLevel: "low", epssScore: 0, kevListedAt: null },
    { vulnId: "CVE-0000-0006", cvssScore: 10, severityLevel: "critical", epssScore: 1, kevListedAt: null },
    {
        vulnId: "CVE-0000-0007",
        cvssScore: 10,
        severityLevel: "critical",
        epssScore: 1,
        kevListedAt: new Date("2020-01-01"),
    },
    // KEV on something mild — the badge and the score disagreeing is correct.
    {
        vulnId: "CVE-0000-0008",
        cvssScore: 3.1,
        severityLevel: "low",
        epssScore: null,
        kevListedAt: new Date("2024-06-01"),
    },
];

describe("risk model parity", () => {
    beforeAll(async () => {
        await cleanAllData();
    });

    beforeEach(async () => {
        const db = getTestDb();
        await db.delete(schema.vulnerabilities);
        await db.insert(schema.vulnerabilities).values(
            withFindingIdentity(
                CASES.map((c) => ({
                    vulnId: c.vulnId,
                    source: "osv",
                    cvssScore: c.cvssScore,
                    severityLevel: c.severityLevel,
                    epssScore: c.epssScore,
                    kevListedAt: c.kevListedAt,
                })),
            ),
        );
    });

    it("computes the same advisory risk in SQL as in TypeScript", async () => {
        const db = getTestDb();
        const rows = await db
            .select({
                vulnId: schema.vulnerabilities.vulnId,
                riskScore: schema.vulnerabilities.riskScore,
            })
            .from(schema.vulnerabilities);

        const byId = new Map(rows.map((r) => [r.vulnId, r.riskScore]));
        expect(byId.size).toBe(CASES.length);

        for (const c of CASES) {
            const fromSql = byId.get(c.vulnId);
            const fromTs = advisoryRisk(c);
            // `real` is single precision, so the two agree to about seven
            // significant figures and not to the bit. Four decimal places is
            // far tighter than any ordering this feeds.
            expect(fromSql, `${c.vulnId} risk_score`).toBeCloseTo(fromTs, 4);
        }
    });

    it("stores a risk score for every advisory, including the unscorable ones", async () => {
        const db = getTestDb();
        const [row] = await db
            .select({ n: sql<number>`count(*) FILTER (WHERE risk_score IS NULL)::int` })
            .from(schema.vulnerabilities);
        // A null score would silently sort to one end of every list. There is
        // no input for which the formula has no answer, and this asserts it.
        expect(row?.n).toBe(0);
    });

    it("recomputes the stored score when EPSS lands, with no second write", async () => {
        const db = getTestDb();
        const before = await db
            .select({ risk: schema.vulnerabilities.riskScore })
            .from(schema.vulnerabilities)
            .where(sql`vuln_id = 'DSA-0000-1'`);

        // Exactly what the EPSS sync does: write the score, touch nothing else.
        await db.execute(sql`UPDATE vulnerabilities SET epss_score = 0.8 WHERE vuln_id = 'DSA-0000-1'`);

        const after = await db
            .select({ risk: schema.vulnerabilities.riskScore })
            .from(schema.vulnerabilities)
            .where(sql`vuln_id = 'DSA-0000-1'`);

        expect(after[0]!.risk).toBeGreaterThan(before[0]!.risk!);
        expect(after[0]!.risk).toBeCloseTo(
            advisoryRisk({ cvssScore: null, severityLevel: "critical", epssScore: 0.8 }),
            4,
        );
    });

    it("refuses a direct write to the generated column", async () => {
        const db = getTestDb();
        // The invariant the column exists for: no caller can put a stale or
        // hand-computed number here.
        await expect(
            db.execute(sql`UPDATE vulnerabilities SET risk_score = 1 WHERE vuln_id = 'MAL-0000-1'`),
        ).rejects.toThrow();
    });

    it("computes the same aggregate in SQL as in TypeScript", async () => {
        const db = getTestDb();
        // The sum, run over the same set both ways. Written against the
        // advisory table directly rather than through `risk.ts` so this tests
        // the arithmetic rather than the joins — the joins are covered by
        // `workload-risk.test.ts`.
        const [row] = await db.execute<{ score: string }>(sql`
            SELECT (round(sum(risk_score))::int)::text AS score
            FROM vulnerabilities
        `);

        const expected = aggregateRisk(CASES.map((c) => advisoryRisk(c)));
        // Both renderings round once, at the end; the slack is that rounding.
        expect(Number(row!.score)).toBeCloseTo(expected, 0);
    });
});
