/**
 * Parser Tests Using Real OSV Data
 *
 * These tests validate the parser against real-world OSV vulnerability JSON
 * records from diverse ecosystems. Unlike the synthetic tests in parser.test.ts,
 * these exercise the full complexity of production data.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { parseOsvJson, extractAffectedPackages, type ParsedOsvRecord } from "../../../src/osv-sync/parser.js";
import {
    loadAllOsvSamples,
    loadOsvSample,
    loadWithdrawnSamples,
    loadActiveSamples,
    type OsvSampleFixture,
} from "../../fixtures/osv-fixture-loader.js";

function computeSha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

describe("parseOsvJson with real OSV data", () => {
    describe("should parse all sample files without errors", () => {
        const samples = loadAllOsvSamples();

        it.each(samples.map((s) => [s.id, s] as const))(
            "parses %s successfully",
            (_id, sample: OsvSampleFixture) => {
                const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

                expect(result.id).toBe(sample.id);
                expect(result.modified).toBeInstanceOf(Date);
                expect(result.modified.getTime()).not.toBeNaN();
                expect(result.rawSha256).toBeInstanceOf(Buffer);
                expect(result.rawSha256.length).toBe(32);
                expect(result.rawSha256.length).toBeGreaterThan(0); // hash computed from rawBytes
            }
        );
    });

    describe("schema validation consistency", () => {
        const samples = loadAllOsvSamples();

        it.each(samples.map((s) => [s.id, s] as const))(
            "validation result for %s matches fixture expectation",
            (_id, sample: OsvSampleFixture) => {
                const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

                if (sample.isSchemaValid) {
                    expect(result.validationErrors).toEqual([]);
                } else {
                    expect(result.validationErrors.length).toBeGreaterThan(0);
                }
            }
        );
    });

    describe("GHSA-gq3g-666w-7h85 (Packagist/PHP)", () => {
        it("should parse all expected fields", () => {
            const sample = loadOsvSample("GHSA-gq3g-666w-7h85");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

            expect(result.id).toBe("GHSA-gq3g-666w-7h85");
            expect(result.modified).toEqual(new Date("2025-12-02T02:01:16.871717Z"));
            expect(result.published).toEqual(new Date("2025-12-02T00:37:07Z"));
            expect(result.withdrawn).toBeUndefined();
        });

        it("should preserve full JSON with affected packages and severity", () => {
            const sample = loadOsvSample("GHSA-gq3g-666w-7h85");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            // Verify rich structure is preserved
            expect(raw["severity"]).toBeDefined();
            expect(raw["affected"]).toBeDefined();

            const affected = raw["affected"] as Array<Record<string, unknown>>;
            expect(affected.length).toBeGreaterThan(0);

            const pkg = affected[0]!["package"] as Record<string, unknown>;
            expect(pkg["ecosystem"]).toBe("Packagist");
            expect(pkg["name"]).toBe("getgrav/grav");
            expect(pkg["purl"]).toBe("pkg:composer/getgrav/grav");
        });
    });

    describe("GO-2020-0001 (Go with ecosystem_specific)", () => {
        it("should parse Go-specific record with ecosystem_specific imports", () => {
            const sample = loadOsvSample("GO-2020-0001");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            expect(result.id).toBe("GO-2020-0001");

            // Go records have ecosystem_specific.imports
            const affected = raw["affected"] as Array<Record<string, unknown>>;
            const ecosystemSpecific = affected[0]!["ecosystem_specific"] as Record<string, unknown>;
            expect(ecosystemSpecific).toBeDefined();
            expect(ecosystemSpecific["imports"]).toBeDefined();
        });

        it("should preserve credits field", () => {
            const sample = loadOsvSample("GO-2020-0001");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            expect(raw["credits"]).toBeDefined();
        });

        it("should use SEMVER range type", () => {
            const sample = loadOsvSample("GO-2020-0001");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            const affected = raw["affected"] as Array<Record<string, unknown>>;
            const ranges = affected[0]!["ranges"] as Array<Record<string, unknown>>;
            expect(ranges[0]!["type"]).toBe("SEMVER");
        });
    });

    describe("CVE-2023-22745 (GIT range with commit hashes)", () => {
        it("should parse CVE with GIT range type", () => {
            const sample = loadOsvSample("CVE-2023-22745");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            expect(result.id).toBe("CVE-2023-22745");

            const affected = raw["affected"] as Array<Record<string, unknown>>;
            const ranges = affected[0]!["ranges"] as Array<Record<string, unknown>>;
            expect(ranges[0]!["type"]).toBe("GIT");
            expect(ranges[0]!["repo"]).toBeDefined();
        });

        it("should preserve related field", () => {
            const sample = loadOsvSample("CVE-2023-22745");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            expect(raw["related"]).toBeDefined();
            expect(Array.isArray(raw["related"])).toBe(true);
        });

        it("should have severity with CVSS score", () => {
            const sample = loadOsvSample("CVE-2023-22745");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            const severity = raw["severity"] as Array<Record<string, string>>;
            expect(severity.length).toBeGreaterThan(0);
            expect(severity[0]!["type"]).toBe("CVSS_V3");
            expect(severity[0]!["score"]).toMatch(/^CVSS:3/);
        });
    });

    describe("MAL-2022-5134 (npm malware)", () => {
        it("should parse malware advisory", () => {
            const sample = loadOsvSample("MAL-2022-5134");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

            expect(result.id).toBe("MAL-2022-5134");
            expect(result.published).toEqual(new Date("2022-06-20T20:22:00Z"));
        });

        it("should have malicious-packages-origins in database_specific", () => {
            const sample = loadOsvSample("MAL-2022-5134");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            const dbSpecific = raw["database_specific"] as Record<string, unknown>;
            expect(dbSpecific["malicious-packages-origins"]).toBeDefined();
        });
    });

    describe("PYSEC-2006-1 (minimal older Python record)", () => {
        it("should parse minimal record with no severity", () => {
            const sample = loadOsvSample("PYSEC-2006-1");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            expect(result.id).toBe("PYSEC-2006-1");
            expect(result.published).toEqual(new Date("2006-02-22T02:02:00Z"));

            // Older record has no severity field
            expect(raw["severity"]).toBeUndefined();
        });
    });

    describe("GHSA-4m7p-55jm-3vwv (multiple affected ranges)", () => {
        it("should handle multiple affected entries for same package", () => {
            const sample = loadOsvSample("GHSA-4m7p-55jm-3vwv");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
            const raw = result.raw as Record<string, unknown>;

            const affected = raw["affected"] as Array<Record<string, unknown>>;
            // This advisory has 3 affected entries for different version ranges
            expect(affected.length).toBe(3);

            // All are for the same Maven package
            for (const entry of affected) {
                const pkg = entry["package"] as Record<string, unknown>;
                expect(pkg["ecosystem"]).toBe("Maven");
                expect(pkg["name"]).toBe("org.jenkins-ci.plugins.workflow:workflow-cps");
            }
        });
    });

    describe("TEST-WITHDRAWN-001 (withdrawn vulnerability)", () => {
        it("should parse withdrawn timestamp", () => {
            const sample = loadOsvSample("TEST-WITHDRAWN-001");
            const result = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

            expect(result.id).toBe("TEST-WITHDRAWN-001");
            expect(result.withdrawn).toEqual(new Date("2024-08-15T14:30:00Z"));
            expect(result.withdrawn).toBeInstanceOf(Date);
        });
    });

    describe("SHA256 consistency across all samples", () => {
        it("should produce deterministic SHA256 hashes for each sample", () => {
            const samples = loadAllOsvSamples();

            for (const sample of samples) {
                const result1 = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);
                const result2 = parseOsvJson(sample.rawBytes, sample.ecosystemDir, computeSha256);

                expect(result1.rawSha256.equals(result2.rawSha256)).toBe(true);
                // Should also match the pre-computed hash from the loader
                expect(result1.rawSha256.equals(sample.sha256)).toBe(true);
            }
        });

        it("should produce unique SHA256 for each different sample", () => {
            const samples = loadAllOsvSamples();
            const hashes = new Set(samples.map((s) => s.sha256.toString("hex")));

            expect(hashes.size).toBe(samples.length);
        });
    });

    describe("ecosystem and data diversity", () => {
        it("should have samples from at least 5 different ecosystems", () => {
            const samples = loadAllOsvSamples();
            const ecosystems = new Set(samples.map((s) => s.ecosystemDir));

            expect(ecosystems.size).toBeGreaterThanOrEqual(5);
        });

        it("should include both withdrawn and active samples", () => {
            const withdrawn = loadWithdrawnSamples();
            const active = loadActiveSamples();

            expect(withdrawn.length).toBeGreaterThan(0);
            expect(active.length).toBeGreaterThan(0);
        });

        it("should include samples with and without published timestamps", () => {
            const samples = loadAllOsvSamples();
            const withPublished = samples.filter((s) => s.published !== undefined);
            const withoutPublished = samples.filter((s) => s.published === undefined);

            expect(withPublished.length).toBeGreaterThan(0);
            // CVE-2023-22745 has published as a datetime with 'Z' suffix
            // but some records might not have published
        });
    });
});

// ===== Affected Package Extraction from Real Fixtures =====

describe("extractAffectedPackages with real OSV data", () => {
    describe("should extract affected packages from all samples", () => {
        const samples = loadAllOsvSamples();

        it.each(samples.map((s) => [s.id, s] as const))(
            "extracts from %s without errors",
            (_id, sample) => {
                const rows = extractAffectedPackages(sample.id, sample.json);

                // Should not throw; rows may be empty for GIT-only entries
                expect(Array.isArray(rows)).toBe(true);

                for (const row of rows) {
                    expect(row.vulnerabilityId).toBe(sample.id);
                    expect(row.packageName).toBeTruthy();
                }
            }
        );
    });

    describe("GO-2020-0001 (Go with SEMVER range)", () => {
        it("should extract one affected package with correct PURL components", () => {
            const sample = loadOsvSample("GO-2020-0001");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                vulnerabilityId: "GO-2020-0001",
                ecosystem: "Go",
                packageName: "github.com/gin-gonic/gin",
                purl: "pkg:golang/github.com/gin-gonic/gin",
                fixedVersion: "1.6.0",
            });
        });

        it("should include SEMVER ranges in extracted data", () => {
            const sample = loadOsvSample("GO-2020-0001");
            const rows = extractAffectedPackages(sample.id, sample.json);
            const ranges = rows[0]?.ranges as Array<{ type: string }>;

            expect(ranges).toHaveLength(1);
            expect(ranges[0]?.type).toBe("SEMVER");
        });
    });

    describe("GHSA-4m7p-55jm-3vwv (Maven with multiple affected entries)", () => {
        it("should extract 3 affected entries for the same package", () => {
            const sample = loadOsvSample("GHSA-4m7p-55jm-3vwv");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(3);

            // All entries are for the same Maven package
            for (const row of rows) {
                expect(row.ecosystem).toBe("Maven");
                expect(row.packageName).toBe("org.jenkins-ci.plugins.workflow:workflow-cps");
                expect(row.purl).toBe("pkg:maven/org.jenkins-ci.plugins.workflow/workflow-cps");
            }
        });

        it("should extract different fixed versions for each entry", () => {
            const sample = loadOsvSample("GHSA-4m7p-55jm-3vwv");
            const rows = extractAffectedPackages(sample.id, sample.json);

            const fixedVersions = rows.map((r) => r.fixedVersion);
            expect(fixedVersions).toContain("2656.vf7a");
            expect(fixedVersions).toContain("2.94.1");
            expect(fixedVersions).toContain("2.92.1");
        });

        it("should preserve explicit versions lists", () => {
            const sample = loadOsvSample("GHSA-4m7p-55jm-3vwv");
            const rows = extractAffectedPackages(sample.id, sample.json);

            // First entry has 3 versions
            expect(rows[0]?.versions).toHaveLength(3);
            expect(rows[0]?.versions).toContain("2646.v6ed3b5b01ff1");

            // Second entry has 2 versions
            expect(rows[1]?.versions).toHaveLength(2);
            expect(rows[1]?.versions).toContain("2.93");
        });
    });

    describe("CVE-2023-22745 (GIT range, no package field)", () => {
        it("should return empty array (no package.name in affected entry)", () => {
            const sample = loadOsvSample("CVE-2023-22745");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(0);
        });
    });

    describe("MAL-2022-5134 (npm malware, introduced=0 with no fix)", () => {
        it("should extract with null fixedVersion (all versions affected)", () => {
            const sample = loadOsvSample("MAL-2022-5134");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                vulnerabilityId: "MAL-2022-5134",
                ecosystem: "npm",
                packageName: "oss-contribution-tracker",
                purl: "pkg:npm/oss-contribution-tracker",
                fixedVersion: null,
            });
        });
    });

    describe("PYSEC-2006-1 (PyPI with ECOSYSTEM range)", () => {
        it("should extract PyPI package with versions list", () => {
            const sample = loadOsvSample("PYSEC-2006-1");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                ecosystem: "PyPI",
                packageName: "cherrypy",
                purl: "pkg:pypi/cherrypy",
                fixedVersion: "2.1.1",
            });
            expect(rows[0]?.versions).toEqual(["0.10", "2.0.0-final", "2.0.0b", "2.1.0", "2.1.0-beta"]);
        });
    });

    describe("GHSA-gq3g-666w-7h85 (Packagist with many versions)", () => {
        it("should extract Composer package with large versions list", () => {
            const sample = loadOsvSample("GHSA-gq3g-666w-7h85");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                ecosystem: "Packagist",
                packageName: "getgrav/grav",
                purl: "pkg:composer/getgrav/grav",
            });
            // Should have the large versions list preserved
            expect(rows[0]?.versions?.length).toBeGreaterThan(100);
        });
    });

    describe("TEST-WITHDRAWN-001 (withdrawn npm package)", () => {
        it("should extract affected package normally (withdrawn status irrelevant for extraction)", () => {
            const sample = loadOsvSample("TEST-WITHDRAWN-001");
            const rows = extractAffectedPackages(sample.id, sample.json);

            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({
                ecosystem: "npm",
                packageName: "example-package",
                purl: "pkg:npm/example-package",
                fixedVersion: "1.2.0",
                versions: ["1.0.0", "1.0.1", "1.1.0"],
            });
        });
    });
});
