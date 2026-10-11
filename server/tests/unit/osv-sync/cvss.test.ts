import { describe, it, expect } from "vitest";
import {
    parseCvssV3,
    parseCvssV4,
    parseCvssV2,
    scoreToLabel,
    scoreToLabelV2,
    normalizeLabel,
    labelToRepresentativeScore,
    extractSeverity,
    type SeverityLabel,
} from "../../../src/osv-sync/cvss.js";

describe("parseCvssV3", () => {
    it("should parse a high-severity vector (GHSA-4m7p)", () => {
        // From GHSA-4m7p-55jm-3vwv.json
        const result = parseCvssV3("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(8.8);
        expect(result!.label).toBe("HIGH");
    });

    it("should parse a medium-severity vector (GHSA-gq3g)", () => {
        // From GHSA-gq3g-666w-7h85.json
        const result = parseCvssV3("CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:L");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(6.2);
        expect(result!.label).toBe("MEDIUM");
    });

    it("should parse a medium-severity vector with local access (CVE-2023-22745)", () => {
        // From CVE-2023-22745.json: local access, high complexity, all CIA high
        const result = parseCvssV3("CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:H");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(6.4);
        expect(result!.label).toBe("MEDIUM");
    });

    it("should parse a critical-severity vector (10.0)", () => {
        const result = parseCvssV3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(10.0);
        expect(result!.label).toBe("CRITICAL");
    });

    it("should parse a low-severity vector", () => {
        const result = parseCvssV3("CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N");
        expect(result).not.toBeNull();
        expect(result!.score).toBeLessThanOrEqual(3.9);
        expect(result!.label).toBe("LOW");
    });

    it("should return NONE when all CIA impacts are None", () => {
        const result = parseCvssV3("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(0);
        expect(result!.label).toBe("NONE");
    });

    it("should handle CVSS:3.0 vectors", () => {
        const result = parseCvssV3("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(9.8);
        expect(result!.label).toBe("CRITICAL");
    });

    it("should handle Scope Changed vectors correctly", () => {
        // Scope changed uses different privilege required weights
        const result = parseCvssV3("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N");
        expect(result).not.toBeNull();
        expect(result!.score).toBe(6.4);
        expect(result!.label).toBe("MEDIUM");
    });

    it("should return null for CVSS v2 vectors", () => {
        expect(parseCvssV3("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toBeNull();
    });

    it("should return null for CVSS v4 vectors", () => {
        expect(parseCvssV3("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    });

    it("should return null for empty string", () => {
        expect(parseCvssV3("")).toBeNull();
    });

    it("should return null for garbage input", () => {
        expect(parseCvssV3("not-a-cvss-vector")).toBeNull();
    });

    it("should return null for vector missing required metrics", () => {
        expect(parseCvssV3("CVSS:3.1/AV:N/AC:L")).toBeNull();
    });

    it("should return null for vector with invalid metric values", () => {
        expect(parseCvssV3("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
    });

    it("should preserve the original vector string", () => {
        const vector = "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H";
        const result = parseCvssV3(vector);
        expect(result!.vector).toBe(vector);
    });
});

describe("scoreToLabel", () => {
    it("should map 0.0 to NONE", () => {
        expect(scoreToLabel(0)).toBe("NONE");
    });

    it("should map 0.1–3.9 to LOW", () => {
        expect(scoreToLabel(0.1)).toBe("LOW");
        expect(scoreToLabel(2.0)).toBe("LOW");
        expect(scoreToLabel(3.9)).toBe("LOW");
    });

    it("should map 4.0–6.9 to MEDIUM", () => {
        expect(scoreToLabel(4.0)).toBe("MEDIUM");
        expect(scoreToLabel(5.5)).toBe("MEDIUM");
        expect(scoreToLabel(6.9)).toBe("MEDIUM");
    });

    it("should map 7.0–8.9 to HIGH", () => {
        expect(scoreToLabel(7.0)).toBe("HIGH");
        expect(scoreToLabel(8.0)).toBe("HIGH");
        expect(scoreToLabel(8.9)).toBe("HIGH");
    });

    it("should map 9.0–10.0 to CRITICAL", () => {
        expect(scoreToLabel(9.0)).toBe("CRITICAL");
        expect(scoreToLabel(9.5)).toBe("CRITICAL");
        expect(scoreToLabel(10.0)).toBe("CRITICAL");
    });
});

describe("normalizeLabel", () => {
    it("should normalize standard labels", () => {
        expect(normalizeLabel("CRITICAL")).toBe("CRITICAL");
        expect(normalizeLabel("HIGH")).toBe("HIGH");
        expect(normalizeLabel("MEDIUM")).toBe("MEDIUM");
        expect(normalizeLabel("LOW")).toBe("LOW");
        expect(normalizeLabel("NONE")).toBe("NONE");
    });

    it("should normalize MODERATE to MEDIUM", () => {
        expect(normalizeLabel("MODERATE")).toBe("MEDIUM");
    });

    it("should be case-insensitive", () => {
        expect(normalizeLabel("critical")).toBe("CRITICAL");
        expect(normalizeLabel("High")).toBe("HIGH");
        expect(normalizeLabel("moderate")).toBe("MEDIUM");
    });

    it("should handle whitespace", () => {
        expect(normalizeLabel("  HIGH  ")).toBe("HIGH");
    });

    it("should return null for unrecognized labels", () => {
        expect(normalizeLabel("UNKNOWN")).toBeNull();
        expect(normalizeLabel("SEVERE")).toBeNull();
        expect(normalizeLabel("")).toBeNull();
    });
});

describe("labelToRepresentativeScore", () => {
    it("should return representative scores for each label", () => {
        expect(labelToRepresentativeScore("NONE")).toBe(0);
        expect(labelToRepresentativeScore("LOW")).toBe(2.0);
        expect(labelToRepresentativeScore("MEDIUM")).toBe(5.5);
        expect(labelToRepresentativeScore("HIGH")).toBe(7.5);
        expect(labelToRepresentativeScore("CRITICAL")).toBe(9.5);
    });

    it("should return scores that map back to the same label", () => {
        const labels: SeverityLabel[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
        for (const label of labels) {
            expect(scoreToLabel(labelToRepresentativeScore(label))).toBe(label);
        }
    });
});

describe("extractSeverity", () => {
    it("drops a publisher's placeholder vector, so the record parses as unscored", () => {
        const placeholder = { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" };
        // Cleanstart's one-vector-fits-all 9.8, at record level and per entry, either version prefix.
        expect(extractSeverity({ id: "CLEANSTART-2026-BX08713", severity: [placeholder] })).toBeNull();
        expect(
            extractSeverity({
                id: "CLEANSTART-2026-KU01035",
                affected: [{ severity: [{ type: "CVSS_V3", score: "CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }],
            }),
        ).toBeNull();
        // The same vector from anyone else is an assessment.
        expect(extractSeverity({ id: "GHSA-aaaa-bbbb-cccc", severity: [placeholder] })?.score).toBe(9.8);
        // A different vector from Cleanstart would count.
        expect(
            extractSeverity({
                id: "CLEANSTART-2026-BX08713",
                severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" }],
            })?.score,
        ).toBe(7.5);
    });

    it("should extract CVSS_V3 from severity array", () => {
        const raw = {
            id: "CVE-2023-22745",
            severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:H" }],
        };

        const result = extractSeverity(raw);

        expect(result).not.toBeNull();
        expect(result!.source).toBe("cvss_v3");
        expect(result!.score).toBe(6.4);
        expect(result!.label).toBe("MEDIUM");
        expect(result!.vector).toBe("CVSS:3.1/AV:L/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:H");
    });

    it("should prefer CVSS_V3 over CVSS_V4 when both present", () => {
        const raw = {
            id: "TEST-BOTH",
            severity: [
                { type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" },
                { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
            ],
        };

        const result = extractSeverity(raw);

        expect(result!.source).toBe("cvss_v3");
        expect(result!.score).toBe(9.8);
    });

    it("should score a CVSS_V4-only record rather than leave it unknown", () => {
        const raw = {
            id: "TEST-V4-ONLY",
            severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }],
        };

        const result = extractSeverity(raw);

        expect(result).not.toBeNull();
        expect(result!.source).toBe("cvss_v4");
        expect(result!.score).toBe(9.3);
        expect(result!.label).toBe("CRITICAL");
        expect(result!.vector).toContain("CVSS:4.0");
    });

    it("should fall back to database_specific.severity text label", () => {
        // Pattern from GHSA entries with database_specific.severity
        const raw = {
            id: "GHSA-test",
            database_specific: {
                severity: "HIGH",
            },
        };

        const result = extractSeverity(raw);

        expect(result).not.toBeNull();
        expect(result!.source).toBe("database_specific");
        expect(result!.label).toBe("HIGH");
        expect(result!.score).toBe(7.5);
        expect(result!.vector).toBeNull();
    });

    it("should normalize MODERATE from database_specific", () => {
        const raw = {
            id: "GHSA-gq3g-666w-7h85",
            database_specific: {
                severity: "MODERATE",
            },
        };

        const result = extractSeverity(raw);

        expect(result!.label).toBe("MEDIUM");
        expect(result!.source).toBe("database_specific");
    });

    it("should prefer CVSS_V3 over database_specific.severity", () => {
        // Like GHSA-gq3g-666w-7h85 which has both
        const raw = {
            id: "GHSA-gq3g-666w-7h85",
            severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:H/A:L" }],
            database_specific: {
                severity: "MODERATE",
            },
        };

        const result = extractSeverity(raw);

        expect(result!.source).toBe("cvss_v3");
        expect(result!.score).toBe(6.2);
    });

    it("should use heuristic for MAL-* IDs (malicious packages)", () => {
        const raw = {
            id: "MAL-2022-5134",
            summary: "Malicious code in oss-contribution-tracker (npm)",
        };

        const result = extractSeverity(raw);

        expect(result).not.toBeNull();
        expect(result!.source).toBe("heuristic");
        expect(result!.label).toBe("CRITICAL");
        expect(result!.score).toBe(9.5);
        expect(result!.vector).toBeNull();
    });

    it("should return null when no severity information is available", () => {
        // Like GO-2020-0001.json or PYSEC-2006-1.json
        const raw = {
            id: "GO-2020-0001",
            summary: "Arbitrary log line injection",
        };

        expect(extractSeverity(raw)).toBeNull();
    });

    it("should return null for null input", () => {
        expect(extractSeverity(null)).toBeNull();
    });

    it("should return null for undefined input", () => {
        expect(extractSeverity(undefined)).toBeNull();
    });

    it("should skip invalid CVSS_V3 vectors and fall through", () => {
        const raw = {
            id: "TEST-INVALID-CVSS",
            severity: [{ type: "CVSS_V3", score: "invalid-vector" }],
            database_specific: {
                severity: "HIGH",
            },
        };

        const result = extractSeverity(raw);

        // Should fall through to database_specific
        expect(result!.source).toBe("database_specific");
        expect(result!.label).toBe("HIGH");
    });

    it("should ignore unrecognized database_specific severity text", () => {
        const raw = {
            id: "TEST-UNKNOWN-LABEL",
            database_specific: {
                severity: "SUPER_DANGEROUS",
            },
        };

        expect(extractSeverity(raw)).toBeNull();
    });

    it("should handle empty severity array", () => {
        const raw = {
            id: "TEST-EMPTY-SEV",
            severity: [],
        };

        expect(extractSeverity(raw)).toBeNull();
    });

    // ----- Everything below was "unknown" before the extractor read the
    // ----- whole OSV record. Each case is a real shape from the mirror.

    it("should fall back to CVSS_V2 when that is the only vector (pre-2016 NVD records)", () => {
        const raw = {
            id: "CVE-2014-0001",
            severity: [{ type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:P/I:P/A:P" }],
        };

        const result = extractSeverity(raw);

        expect(result).toMatchObject({ source: "cvss_v2", score: 7.5, label: "HIGH" });
    });

    it("should prefer CVSS_V4 over CVSS_V2 and CVSS_V3 over CVSS_V4", () => {
        const v2 = { type: "CVSS_V2", score: "AV:N/AC:L/Au:N/C:P/I:P/A:P" };
        const v3 = { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" };
        const v4 = { type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" };

        expect(extractSeverity({ id: "X", severity: [v2, v4] })!.source).toBe("cvss_v4");
        expect(extractSeverity({ id: "X", severity: [v2, v4, v3] })!.source).toBe("cvss_v3");
    });

    it("should read the OSV `Ubuntu` severity type as a priority label", () => {
        const raw = {
            id: "UBUNTU-CVE-2024-0001",
            severity: [{ type: "Ubuntu", score: "Medium" }],
        };

        expect(extractSeverity(raw)).toMatchObject({ source: "ubuntu", label: "MEDIUM", score: 5.5 });
    });

    it("should read affected[].severity when the record-level array is absent", () => {
        const raw = {
            id: "RLSA-2024:0001",
            affected: [
                {
                    package: { ecosystem: "Rocky Linux:9", name: "kernel" },
                    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H" }],
                },
            ],
        };

        expect(extractSeverity(raw)).toMatchObject({ source: "cvss_v3", score: 7.8, label: "HIGH" });
    });

    it("should take the worst affected[].severity across entries", () => {
        const raw = {
            id: "MULTI",
            affected: [
                { severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N" }] }, // low
                { severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }, // 9.8
                { severity: [] },
            ],
        };

        expect(extractSeverity(raw)!.score).toBe(9.8);
    });

    it("should prefer a vector in affected[] over a text label at record level", () => {
        const raw = {
            id: "X",
            database_specific: { severity: "LOW" },
            affected: [{ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] }],
        };

        expect(extractSeverity(raw)).toMatchObject({ source: "cvss_v3", score: 9.8 });
    });

    it("should read Debian urgency from affected[].ecosystem_specific", () => {
        const raw = {
            id: "DEBIAN-CVE-2023-0001",
            affected: [
                {
                    package: { ecosystem: "Debian:12", name: "curl" },
                    ecosystem_specific: { urgency: "high" },
                },
            ],
        };

        expect(extractSeverity(raw)).toMatchObject({ source: "ecosystem_specific", label: "HIGH" });
    });

    it("should leave a Debian 'not yet assigned' urgency unscored", () => {
        const raw = {
            id: "DEBIAN-CVE-2023-0002",
            affected: [{ ecosystem_specific: { urgency: "not yet assigned" } }],
        };

        expect(extractSeverity(raw)).toBeNull();
    });

    it("should map distro vocabularies: Important → HIGH, Negligible/unimportant → LOW", () => {
        expect(extractSeverity({ id: "A", database_specific: { severity: "Important" } })).toMatchObject({
            label: "HIGH",
        });
        expect(extractSeverity({ id: "B", database_specific: { priority: "Negligible" } })).toMatchObject({
            label: "LOW",
        });
        expect(
            extractSeverity({ id: "C", affected: [{ ecosystem_specific: { urgency: "unimportant" } }] }),
        ).toMatchObject({ label: "LOW" });
    });

    it("should not guess at 'untriaged' or 'unknown' text labels", () => {
        expect(extractSeverity({ id: "A", database_specific: { severity: "untriaged" } })).toBeNull();
        expect(extractSeverity({ id: "B", database_specific: { severity: "unknown" } })).toBeNull();
    });

    it("should take the worst text label across affected[] entries", () => {
        const raw = {
            id: "X",
            affected: [
                { ecosystem_specific: { urgency: "low" } },
                { ecosystem_specific: { urgency: "high" } },
                { ecosystem_specific: { urgency: "medium" } },
            ],
        };

        expect(extractSeverity(raw)!.label).toBe("HIGH");
    });

    it("should still score a record that has an unparseable CVSS_V4 vector and a label", () => {
        const raw = {
            id: "X",
            severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L" }],
            database_specific: { severity: "MODERATE" },
        };

        expect(extractSeverity(raw)).toMatchObject({ source: "database_specific", label: "MEDIUM" });
    });

    it("should tolerate malformed affected entries", () => {
        const raw = {
            id: "X",
            affected: [null, "nope", { severity: "not-an-array" }, { ecosystem_specific: null }],
        };

        expect(extractSeverity(raw)).toBeNull();
    });
});

describe("parseCvssV4", () => {
    it("should compute the base score for a full-impact network vector", () => {
        const result = parseCvssV4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
        expect(result).toEqual({
            vector: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N",
            score: 9.3,
            label: "CRITICAL",
        });
    });

    it("should compute a mid-band score", () => {
        // FIRST's own calculator example: 5.3 MEDIUM
        const result = parseCvssV4("CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N");
        expect(result!.label).toBe("MEDIUM");
        expect(result!.score).toBeGreaterThanOrEqual(4.0);
        expect(result!.score).toBeLessThanOrEqual(6.9);
    });

    it("should ignore threat metrics and return the base score", () => {
        const base = parseCvssV4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
        const withThreat = parseCvssV4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:P");
        expect(withThreat!.score).toBe(base!.score);
    });

    it("should return NONE for a no-impact vector", () => {
        const result = parseCvssV4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N");
        expect(result).toMatchObject({ score: 0, label: "NONE" });
    });

    it("should return null for partial, v3, or garbage vectors", () => {
        expect(parseCvssV4("CVSS:4.0/AV:N/AC:L")).toBeNull();
        expect(parseCvssV4("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
        expect(parseCvssV4("garbage")).toBeNull();
        expect(parseCvssV4("")).toBeNull();
    });
});

describe("parseCvssV2", () => {
    it("should compute the classic 7.5 vector", () => {
        expect(parseCvssV2("AV:N/AC:L/Au:N/C:P/I:P/A:P")).toMatchObject({ score: 7.5, label: "HIGH" });
    });

    it("should accept the CVSS:2.0/ prefix", () => {
        expect(parseCvssV2("CVSS:2.0/AV:N/AC:L/Au:N/C:P/I:P/A:P")!.score).toBe(7.5);
    });

    it("should compute a 10.0 and cap the label at HIGH (v2 has no CRITICAL)", () => {
        expect(parseCvssV2("AV:N/AC:L/Au:N/C:C/I:C/A:C")).toMatchObject({ score: 10, label: "HIGH" });
    });

    it("should compute a low-band score", () => {
        expect(parseCvssV2("AV:L/AC:H/Au:M/C:P/I:N/A:N")!.label).toBe("LOW");
    });

    it("should return null for partial, v3, or garbage vectors", () => {
        expect(parseCvssV2("AV:N/AC:L")).toBeNull();
        expect(parseCvssV2("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
        expect(parseCvssV2("garbage")).toBeNull();
    });
});

describe("scoreToLabelV2", () => {
    it("should use NVD's v2 bands", () => {
        expect(scoreToLabelV2(0)).toBe("NONE");
        expect(scoreToLabelV2(3.9)).toBe("LOW");
        expect(scoreToLabelV2(4.0)).toBe("MEDIUM");
        expect(scoreToLabelV2(7.0)).toBe("HIGH");
        expect(scoreToLabelV2(10)).toBe("HIGH");
    });
});
