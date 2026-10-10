/**
 * Cross-image finding delta parity with the chart index. The chart index
 * worker carries a copy of `diffFindings` / `summariseDelta`
 * (`charts/src/worker/score/delta.ts`, ADR 0001: copies, not a shared
 * package). `tests/fixtures/delta-cases.json` is the same file as
 * `charts/tests/fixtures/delta-cases.json` —
 * `scripts/check-cross-app-constants.mjs` holds them byte-equal — and both
 * sides run its cases, so a rule that changes here fails there too.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { diffFindings, summariseDelta, type ComparableFinding, type DeltaSummary } from "../../../src/db/finding-delta.js";

type FixtureFinding = { key: string; vulnId: string; risk: number; kev: boolean; severity: string | null };
type Case = {
    name: string;
    from: FixtureFinding[];
    to: FixtureFinding[];
    expect: { resolved: string[]; introduced: string[]; unchanged: string[]; summary: DeltaSummary };
};

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/delta-cases.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as { cases: Case[] };

function comparable(f: FixtureFinding): ComparableFinding {
    const [packageType, packageName] = f.key.split("|");
    return {
        key: f.key,
        vulnId: f.vulnId,
        packageName: packageName ?? "",
        packageType: packageType ?? "",
        purlType: null,
        packageVersion: null,
        severityLevel: f.severity,
        riskScore: f.risk,
        kevListed: f.kev,
        epssScore: null,
        fixedVersion: null,
        bucket: "unknown",
    };
}

describe("diffFindings / summariseDelta (fixture shared with charts/)", () => {
    it.each(fixture.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
        const delta = diffFindings("from", "to", c.from.map(comparable), c.to.map(comparable));
        expect(delta.resolved.map((f) => f.vulnId)).toEqual(c.expect.resolved);
        expect(delta.introduced.map((f) => f.vulnId)).toEqual(c.expect.introduced);
        expect(delta.unchanged.map((f) => f.vulnId)).toEqual(c.expect.unchanged);
        expect(summariseDelta(delta)).toEqual(c.expect.summary);
    });
});

describe("diffFindings rescored", () => {
    const finding = (key: string, severity: string | null, risk = 10): ComparableFinding =>
        comparable({ key, vulnId: key.split("|")[2] ?? key, risk, kev: false, severity });

    it("reports a finding present on both sides whose band moved, in its after state", () => {
        const from = [finding("npm|a|CVE-1", null), finding("npm|b|CVE-2", "high"), finding("npm|c|CVE-3", "low")];
        const to = [finding("npm|a|CVE-1", "critical", 90), finding("npm|b|CVE-2", "HIGH"), finding("npm|c|CVE-3", "medium")];
        const delta = diffFindings("img", "img", from, to);

        expect(delta.resolved).toEqual([]);
        expect(delta.introduced).toEqual([]);
        expect(delta.unchanged.map((f) => f.vulnId).sort()).toEqual(["CVE-1", "CVE-2", "CVE-3"]);
        // CVE-2 only changed case, which is the same band. Worst first.
        expect(delta.rescored.map((f) => [f.vulnId, f.previousSeverityLevel, f.severityLevel])).toEqual([
            ["CVE-1", null, "critical"],
            ["CVE-3", "low", "medium"],
        ]);
    });

    it("is empty across two images that carry the same advisories", () => {
        const from = [finding("npm|a|CVE-1", "high")];
        const to = [finding("npm|a|CVE-1", "high"), finding("npm|b|CVE-2", "low")];
        expect(diffFindings("from", "to", from, to).rescored).toEqual([]);
    });
});
