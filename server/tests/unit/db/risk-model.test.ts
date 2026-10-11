/**
 * The risk formula, pinned.
 *
 * Three things are checked, and the third is the one that matters most.
 *
 *  1. The shape of `advisoryRisk` — that the inversions the feature exists to
 *     produce actually happen, and that "no data" lands where it was
 *     documented to land rather than at zero.
 *  2. The properties `aggregateRisk` is required to have — an unbounded,
 *     monotone, composable sum (ADR 0007). Written as properties over
 *     generated inputs rather than as golden numbers, because "adding a
 *     finding never lowers the score" is the claim, and a fixture only
 *     demonstrates it for one list.
 *  3. That the SQL and TypeScript renderings agree. `tests/integration/findings/
 *     risk-model-parity.test.ts` is that one — it needs a database, so it lives
 *     next to the other cross-rendering test rather than here.
 */

import { describe, it, expect } from "vitest";
import {
    advisoryRisk,
    aggregateRisk,
    exploitability,
    impact,
    riskBand,
    UNSCORED_EXPLOITABILITY,
} from "../../../src/db/risk-model.js";

const kev = new Date("2021-12-10T00:00:00Z");

describe("advisoryRisk", () => {
    it("puts an exploited medium above an unexploited critical", () => {
        const exploitedMedium = advisoryRisk({
            cvssScore: 5.3,
            severityLevel: "medium",
            epssScore: 0.9,
        });
        const quietCritical = advisoryRisk({
            cvssScore: 9.8,
            severityLevel: "critical",
            epssScore: 0.0004,
        });

        // The whole point of the feature. If this assertion ever flips, the
        // score has become a restatement of CVSS.
        expect(exploitedMedium).toBeGreaterThan(quietCritical);
        expect(exploitedMedium).toBeCloseTo(51.2, 0);
        expect(quietCritical).toBeCloseTo(7.2, 0);
    });

    it("gives a KEV listing the maximum exploitation weight", () => {
        expect(exploitability({ kevListedAt: kev })).toBe(1);
        // …and outranks a non-KEV advisory of equal severity, whatever its EPSS.
        expect(advisoryRisk({ cvssScore: 7.5, kevListedAt: kev })).toBeGreaterThan(
            advisoryRisk({ cvssScore: 7.5, epssScore: 0.99 }),
        );
    });

    it("does not treat a missing EPSS score as zero risk", () => {
        expect(exploitability({ epssScore: null })).toBe(UNSCORED_EXPLOITABILITY);
        // An unscored critical must still outrank a scored-but-quiet low.
        expect(advisoryRisk({ cvssScore: 9.8, severityLevel: "critical" })).toBeGreaterThan(
            advisoryRisk({ cvssScore: 2.1, severityLevel: "low", epssScore: 0.0002 }),
        );
    });

    it("falls back to the severity band when there is no CVSS score", () => {
        expect(impact({ cvssScore: null, severityLevel: "critical" })).toBeCloseTo(0.9);
        expect(impact({ cvssScore: null, severityLevel: "LOW" })).toBeCloseTo(0.2);
        // Neither score nor band — a mid value, not a zero.
        expect(impact({ cvssScore: null, severityLevel: null })).toBeCloseTo(0.4);
    });

    it("clamps inputs outside their documented ranges", () => {
        expect(impact({ cvssScore: 42 })).toBe(1);
        expect(impact({ cvssScore: -1 })).toBe(0);
        expect(exploitability({ epssScore: 5 })).toBe(1);
        expect(exploitability({ epssScore: -1 })).toBe(0);
    });

    it("is monotone in both inputs", () => {
        for (const epss of [0.0001, 0.01, 0.3, 0.99]) {
            expect(advisoryRisk({ cvssScore: 9, epssScore: epss })).toBeGreaterThan(
                advisoryRisk({ cvssScore: 4, epssScore: epss }),
            );
        }
        for (const cvss of [1, 4, 7.5, 10]) {
            expect(advisoryRisk({ cvssScore: cvss, epssScore: 0.9 })).toBeGreaterThan(
                advisoryRisk({ cvssScore: cvss, epssScore: 0.001 }),
            );
        }
    });
});

describe("aggregateRisk", () => {
    it("is the sum of its findings — a magnitude, not a ranking", () => {
        // The number Dependency-Track users expect: ten criticals really are
        // ten times one critical. Worst-domination moved to the rollup's band.
        expect(aggregateRisk([98])).toBe(98);
        expect(aggregateRisk(Array(10).fill(98))).toBe(980);
        expect(aggregateRisk(Array(500).fill(0.2))).toBe(100);
    });

    it("is unbounded — it grows with the pile and shrinks as it is fixed", () => {
        expect(aggregateRisk(Array(1000).fill(100))).toBe(100_000);
        const before = aggregateRisk([98, 51, 22, 15]);
        const afterFix = aggregateRisk([51, 22, 15]);
        expect(before - afterFix).toBe(98);
    });

    it("is monotone — an extra finding never improves the score", () => {
        const base = [51, 22, 15, 3, 1.2];
        for (const extra of [0.01, 1, 20, 90]) {
            expect(aggregateRisk([...base, extra])).toBeGreaterThanOrEqual(aggregateRisk(base) - 1e-9);
        }
    });

    it("is independent of input order", () => {
        const findings = [3, 51, 0.2, 22, 98, 1.2, 15];
        const shuffled = [98, 0.2, 22, 3, 15, 1.2, 51];
        expect(aggregateRisk(findings)).toBe(aggregateRisk(shuffled));
    });

    it("composes — a whole is the sum of its parts", () => {
        // What lets a cluster's total be read as the sum of its images', and
        // what the old rank-decayed fold could not offer. Rounding is the only
        // slack, hence closeTo.
        const imageA = [98, 12, 0.2];
        const imageB = [51, 3];
        expect(aggregateRisk([...imageA, ...imageB])).toBeCloseTo(aggregateRisk(imageA) + aggregateRisk(imageB), 0);
    });

    it("scores an empty group zero", () => {
        expect(aggregateRisk([])).toBe(0);
        expect(aggregateRisk([0])).toBe(0);
    });
});

describe("riskBand", () => {
    it("bands on the compressed range the score actually occupies", () => {
        expect(riskBand(98)).toBe("critical");
        expect(riskBand(51)).toBe("high");
        expect(riskBand(22)).toBe("medium");
        expect(riskBand(7)).toBe("low");
        expect(riskBand(0)).toBe("none");
        expect(riskBand(null)).toBe("none");
    });
});
