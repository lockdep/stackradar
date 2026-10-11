import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
    parseOsvJson,
    extractEcosystemDir,
    filterUpdateCandidates,
    toBasePurl,
    extractAffectedPackages,
    convertOsvRecordToVulnerability,
    type ModifiedEntry,
} from "../../../src/osv-sync/parser.js";

function computeSha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

describe("parseOsvJson", () => {
    it("should parse valid OSV JSON record", () => {
        const osvRecord = {
            id: "PYSEC-2024-1",
            modified: "2024-01-15T10:30:00Z",
            published: "2024-01-10T08:00:00Z",
            summary: "Test vulnerability",
            details: "This is a test vulnerability for unit testing.",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "PyPI", computeSha256);

        expect(result.id).toBe("PYSEC-2024-1");
        expect(result.modified).toEqual(new Date("2024-01-15T10:30:00Z"));
        expect(result.published).toEqual(new Date("2024-01-10T08:00:00Z"));
        expect(result.withdrawn).toBeUndefined();
        expect(result.raw).toEqual(osvRecord);
        expect(result.rawSha256).toBeInstanceOf(Buffer);
        expect(result.rawSha256.length).toBe(32); // SHA256 is 32 bytes
        expect(result.validationErrors).toBeDefined();
    });

    it("should handle withdrawn vulnerabilities", () => {
        const osvRecord = {
            id: "CVE-2024-9999",
            modified: "2024-01-15T10:30:00Z",
            withdrawn: "2024-01-14T12:00:00Z",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "NVD", computeSha256);

        expect(result.withdrawn).toEqual(new Date("2024-01-14T12:00:00Z"));
        expect(result.validationErrors).toBeDefined();
    });

    it("should handle record without published timestamp", () => {
        const osvRecord = {
            id: "GHSA-xxxx",
            modified: "2024-01-15T10:30:00Z",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "GitHub", computeSha256);

        expect(result.published).toBeUndefined();
    });

    it("should throw error for missing id field", () => {
        const osvRecord = {
            modified: "2024-01-15T10:30:00Z",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        expect(() => parseOsvJson(rawBytes, "PyPI", computeSha256)).toThrow("OSV record missing 'id' field");
    });

    it("should throw error for missing modified field", () => {
        const osvRecord = {
            id: "PYSEC-2024-1",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        expect(() => parseOsvJson(rawBytes, "PyPI", computeSha256)).toThrow("missing 'modified' field");
    });

    it("should throw error for invalid modified timestamp", () => {
        const osvRecord = {
            id: "PYSEC-2024-1",
            modified: "not-a-timestamp",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        expect(() => parseOsvJson(rawBytes, "PyPI", computeSha256)).toThrow("invalid 'modified' timestamp");
    });

    it("should handle invalid published timestamp gracefully", () => {
        const osvRecord = {
            id: "PYSEC-2024-1",
            modified: "2024-01-15T10:30:00Z",
            published: "invalid-date",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "PyPI", computeSha256);

        expect(result.published).toBeUndefined();
    });

    it("should produce consistent SHA256 for same input", () => {
        const osvRecord = { id: "TEST-1", modified: "2024-01-15T10:30:00Z" };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result1 = parseOsvJson(rawBytes, "Test", computeSha256);
        const result2 = parseOsvJson(rawBytes, "Test", computeSha256);

        expect(result1.rawSha256.equals(result2.rawSha256)).toBe(true);
    });

    it("should produce different SHA256 for different input", () => {
        const rawBytes1 = Buffer.from(JSON.stringify({ id: "TEST-1", modified: "2024-01-15T10:30:00Z" }));
        const rawBytes2 = Buffer.from(JSON.stringify({ id: "TEST-2", modified: "2024-01-15T10:30:00Z" }));

        const result1 = parseOsvJson(rawBytes1, "Test", computeSha256);
        const result2 = parseOsvJson(rawBytes2, "Test", computeSha256);

        expect(result1.rawSha256.equals(result2.rawSha256)).toBe(false);
    });

    it("should report validation errors for records with invalid id prefix", () => {
        const osvRecord = {
            id: "TEST-MINIMAL",
            modified: "2024-01-15T10:30:00Z",
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "Test", computeSha256);

        // "TEST-" is not a recognized OSV id prefix, so schema validation fails
        // but parsing still succeeds (validation is non-blocking)
        expect(result.id).toBe("TEST-MINIMAL");
        expect(result.validationErrors).toBeDefined();
        expect(result.validationErrors.length).toBeGreaterThan(0);
    });

    it("should return empty validationErrors for a schema-compliant record", () => {
        const osvRecord = {
            id: "GHSA-test-0001",
            modified: "2024-06-01T12:00:00Z",
            published: "2024-05-30T10:00:00Z",
            summary: "Test advisory for schema compliance",
            affected: [
                {
                    package: {
                        ecosystem: "npm",
                        name: "test-package",
                    },
                    ranges: [
                        {
                            type: "SEMVER",
                            events: [{ introduced: "0" }, { fixed: "1.2.3" }],
                        },
                    ],
                },
            ],
        };
        const rawBytes = Buffer.from(JSON.stringify(osvRecord));

        const result = parseOsvJson(rawBytes, "npm", computeSha256);

        expect(result.id).toBe("GHSA-test-0001");
        expect(result.validationErrors).toEqual([]);
    });
});

describe("severity_level derivation (parseOsvJson → convertOsvRecordToVulnerability)", () => {
    const convert = (record: object, ecosystem = "Test") =>
        convertOsvRecordToVulnerability(parseOsvJson(Buffer.from(JSON.stringify(record)), ecosystem, computeSha256));

    it("stores 'unknown' only when the record carries no severity anywhere", () => {
        const row = convert({
            id: "ALPINE-CVE-2024-1",
            modified: "2024-01-01T00:00:00Z",
            affected: [{ package: { ecosystem: "Alpine:v3.19", name: "busybox" } }],
        });
        expect(row.severityLevel).toBe("unknown");
        expect(row.cvssScore).toBeNull();
    });

    it("scores a CVSS v4-only GHSA record", () => {
        const row = convert({
            id: "GHSA-v4v4-v4v4-v4v4",
            modified: "2024-01-01T00:00:00Z",
            severity: [{ type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" }],
        });
        expect(row.severityLevel).toBe("critical");
        expect(row.cvssScore).toBe(9.3);
        // The raw OSV severity array is stored verbatim, per the schema.
        expect(row.severity).toEqual([
            { type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" },
        ]);
    });

    it("labels a Debian record from affected[].ecosystem_specific.urgency", () => {
        const row = convert(
            {
                id: "DEBIAN-CVE-2024-1",
                modified: "2024-01-01T00:00:00Z",
                affected: [
                    { package: { ecosystem: "Debian:12", name: "curl" }, ecosystem_specific: { urgency: "medium" } },
                ],
            },
            "Debian",
        );
        expect(row.severityLevel).toBe("medium");
        expect(row.cvssScore).toBe(5.5);
    });

    it("labels a Rocky record from affected[].severity", () => {
        const row = convert({
            id: "RLSA-2024:0001",
            modified: "2024-01-01T00:00:00Z",
            affected: [
                {
                    package: { ecosystem: "Rocky Linux:9", name: "kernel" },
                    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H" }],
                },
            ],
        });
        expect(row.severityLevel).toBe("high");
        expect(row.cvssScore).toBe(7.8);
    });
});

describe("extractEcosystemDir", () => {
    it("should extract ecosystem from affected[0].package.ecosystem", () => {
        const raw = {
            id: "GHSA-test-0001",
            affected: [{ package: { ecosystem: "npm", name: "test-pkg" } }],
        };
        expect(extractEcosystemDir(raw)).toBe("npm");
    });

    it("should strip version suffix from ecosystem", () => {
        const raw = {
            id: "ALBA-2019:0973",
            affected: [{ package: { ecosystem: "AlmaLinux:8", name: "some-pkg" } }],
        };
        expect(extractEcosystemDir(raw)).toBe("AlmaLinux");
    });

    it("should strip version suffix with multiple colons", () => {
        const raw = {
            id: "DLA-1234-1",
            affected: [{ package: { ecosystem: "Debian:11", name: "some-pkg" } }],
        };
        expect(extractEcosystemDir(raw)).toBe("Debian");
    });

    it("should return ecosystem as-is when no colon present", () => {
        const raw = {
            id: "PYSEC-2024-1",
            affected: [{ package: { ecosystem: "PyPI", name: "test-pkg" } }],
        };
        expect(extractEcosystemDir(raw)).toBe("PyPI");
    });

    it("should use first affected entry when multiple exist", () => {
        const raw = {
            id: "CVE-2024-1234",
            affected: [
                { package: { ecosystem: "npm", name: "pkg-a" } },
                { package: { ecosystem: "PyPI", name: "pkg-b" } },
            ],
        };
        expect(extractEcosystemDir(raw)).toBe("npm");
    });

    it("should return empty string when affected array is empty", () => {
        const raw = { id: "CVE-2024-1234", affected: [] };
        expect(extractEcosystemDir(raw)).toBe("");
    });

    it("should return empty string when affected is missing", () => {
        const raw = { id: "CVE-2024-1234" };
        expect(extractEcosystemDir(raw)).toBe("");
    });

    it("should return empty string when package is missing", () => {
        const raw = { id: "CVE-2024-1234", affected: [{}] };
        expect(extractEcosystemDir(raw)).toBe("");
    });

    it("should return empty string when ecosystem is missing", () => {
        const raw = { id: "CVE-2024-1234", affected: [{ package: {} }] };
        expect(extractEcosystemDir(raw)).toBe("");
    });

    it("should handle null/undefined input gracefully", () => {
        expect(extractEcosystemDir(null)).toBe("");
        expect(extractEcosystemDir(undefined)).toBe("");
    });
});

describe("filterUpdateCandidates", () => {
    const createEntry = (timestamp: string, path: string): ModifiedEntry => {
        const [ecosystemDir, vulnId] = path.split("/");
        return {
            modifiedTimestamp: new Date(timestamp),
            ecosystemDir: ecosystemDir!,
            vulnId: vulnId!,
            path,
        };
    };

    it("should return all entries when lastModifiedApplied is null", () => {
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/PYSEC-1"),
            createEntry("2024-01-15T10:25:00Z", "npm/GHSA-2"),
            createEntry("2024-01-15T10:20:00Z", "Go/CVE-3"),
        ];

        const { candidates, deduplications } = filterUpdateCandidates(entries, null, 10);

        expect(candidates).toHaveLength(3);
        expect(deduplications).toHaveLength(0);
        // Should be sorted by timestamp ascending
        expect(candidates[0]?.vulnId).toBe("CVE-3");
        expect(candidates[1]?.vulnId).toBe("GHSA-2");
        expect(candidates[2]?.vulnId).toBe("PYSEC-1");
    });

    it("should filter entries using overlap window", () => {
        const lastModifiedApplied = new Date("2024-01-15T10:25:00Z");
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/PYSEC-1"), // After watermark
            createEntry("2024-01-15T10:25:00Z", "npm/GHSA-2"), // At watermark
            createEntry("2024-01-15T10:20:00Z", "Go/CVE-3"), // Within overlap (5 mins before)
            createEntry("2024-01-15T10:10:00Z", "Debian/DSA-4"), // Before overlap window (15 mins before)
        ];

        const { candidates, deduplications } = filterUpdateCandidates(entries, lastModifiedApplied, 10);

        // Should include entries at/after watermark minus overlap (10:15:00)
        expect(candidates).toHaveLength(3);
        expect(deduplications).toHaveLength(0);
        expect(candidates.map((e) => e.vulnId)).toEqual(["CVE-3", "GHSA-2", "PYSEC-1"]);
    });

    it("should return empty array when no candidates match", () => {
        const lastModifiedApplied = new Date("2024-01-15T12:00:00Z");
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/PYSEC-1"),
            createEntry("2024-01-15T10:25:00Z", "npm/GHSA-2"),
        ];

        // 10 min overlap: cutoff = 11:50, all entries are before that
        const { candidates } = filterUpdateCandidates(entries, lastModifiedApplied, 10);

        expect(candidates).toHaveLength(0);
    });

    it("should handle empty entries array", () => {
        const { candidates } = filterUpdateCandidates([], new Date(), 10);
        expect(candidates).toHaveLength(0);
    });

    it("should sort candidates by timestamp ascending", () => {
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/PYSEC-1"),
            createEntry("2024-01-15T10:10:00Z", "npm/GHSA-2"),
            createEntry("2024-01-15T10:20:00Z", "Go/CVE-3"),
        ];

        const { candidates } = filterUpdateCandidates(entries, null, 10);

        expect(candidates[0]?.modifiedTimestamp.getTime()).toBeLessThan(candidates[1]!.modifiedTimestamp.getTime());
        expect(candidates[1]?.modifiedTimestamp.getTime()).toBeLessThan(candidates[2]!.modifiedTimestamp.getTime());
    });

    it("should deduplicate same vulnId across ecosystem dirs", () => {
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/CVE-2024-1234"),
            createEntry("2024-01-15T10:30:00Z", "npm/CVE-2024-1234"),
            createEntry("2024-01-15T10:25:00Z", "Go/GHSA-5678"),
        ];

        const { candidates, deduplications } = filterUpdateCandidates(entries, null, 10);

        expect(candidates).toHaveLength(2);
        expect(candidates.map((e) => e.vulnId).sort()).toEqual(["CVE-2024-1234", "GHSA-5678"]);

        expect(deduplications).toHaveLength(1);
        expect(deduplications[0]?.vulnId).toBe("CVE-2024-1234");
        expect(deduplications[0]?.ecosystemDirs.sort()).toEqual(["PyPI", "npm"]);
    });

    it("should keep entry with latest timestamp when deduplicating", () => {
        const entries = [
            createEntry("2024-01-15T10:20:00Z", "PyPI/CVE-2024-1234"),
            createEntry("2024-01-15T10:30:00Z", "npm/CVE-2024-1234"),
        ];

        const { candidates } = filterUpdateCandidates(entries, null, 10);

        expect(candidates).toHaveLength(1);
        expect(candidates[0]?.ecosystemDir).toBe("npm");
        expect(candidates[0]?.modifiedTimestamp).toEqual(new Date("2024-01-15T10:30:00Z"));
    });

    it("should report all ecosystem dirs in deduplication details", () => {
        const entries = [
            createEntry("2024-01-15T10:30:00Z", "PyPI/CVE-2024-9999"),
            createEntry("2024-01-15T10:30:00Z", "npm/CVE-2024-9999"),
            createEntry("2024-01-15T10:30:00Z", "Go/CVE-2024-9999"),
        ];

        const { candidates, deduplications } = filterUpdateCandidates(entries, null, 10);

        expect(candidates).toHaveLength(1);
        expect(deduplications).toHaveLength(1);
        expect(deduplications[0]?.ecosystemDirs.sort()).toEqual(["Go", "PyPI", "npm"]);
    });
});

describe("toBasePurl", () => {
    it("should strip version from a PURL", () => {
        expect(toBasePurl("pkg:npm/lodash@4.17.15")).toBe("pkg:npm/lodash");
    });

    it("should strip version and qualifiers", () => {
        expect(toBasePurl("pkg:npm/lodash@4.17.15?vcs_url=https://github.com")).toBe("pkg:npm/lodash");
    });

    it("should strip subpath", () => {
        expect(toBasePurl("pkg:npm/lodash@4.17.15#dist/index.js")).toBe("pkg:npm/lodash");
    });

    it("should leave versionless PURL unchanged", () => {
        expect(toBasePurl("pkg:npm/lodash")).toBe("pkg:npm/lodash");
    });

    it("repairs osv.dev's SUSE purls, whose qualifier is glued onto the name", () => {
        // Read literally the base purl would keep the whole distro string as
        // part of the package name (`pkg:rpm/suse/curl%26distro%3DSUSE%20…`).
        expect(toBasePurl("pkg:rpm/suse/curl&distro=SUSE%20Linux%20Enterprise%20Server%2015%20SP7")).toBe(
            "pkg:rpm/suse/curl",
        );
        expect(toBasePurl("pkg:rpm/opensuse/curl&distro=openSUSE%20Leap%2015.6")).toBe("pkg:rpm/opensuse/curl");
    });

    it("should handle PURL with namespace (Maven)", () => {
        expect(toBasePurl("pkg:maven/org.apache.commons/commons-lang3@3.12.0")).toBe(
            "pkg:maven/org.apache.commons/commons-lang3",
        );
    });

    it("should handle PURL with encoded namespace (npm scoped)", () => {
        expect(toBasePurl("pkg:npm/%40angular/core@16.0.0")).toBe("pkg:npm/%40angular/core");
    });

    it("should handle Go PURL with deep namespace", () => {
        expect(toBasePurl("pkg:golang/github.com/gin-gonic/gin@1.6.0")).toBe("pkg:golang/github.com/gin-gonic/gin");
    });

    it("should handle Composer PURL", () => {
        expect(toBasePurl("pkg:composer/getgrav/grav@1.7.0")).toBe("pkg:composer/getgrav/grav");
    });

    it("should handle PyPI PURL", () => {
        expect(toBasePurl("pkg:pypi/cherrypy@2.1.0")).toBe("pkg:pypi/cherrypy");
    });

    it("should fallback gracefully for malformed PURLs", () => {
        // Regex fallback strips everything after @ or ? or #
        const result = toBasePurl("totally-invalid@1.0.0");
        expect(result).toBe("totally-invalid");
    });
});

describe("extractAffectedPackages", () => {
    it("should extract single affected package with PURL", () => {
        const raw = {
            id: "GO-2020-0001",
            affected: [
                {
                    package: {
                        name: "github.com/gin-gonic/gin",
                        ecosystem: "Go",
                        purl: "pkg:golang/github.com/gin-gonic/gin",
                    },
                    ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.6.0" }] }],
                },
            ],
        };

        const rows = extractAffectedPackages("GO-2020-0001", raw);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            vulnerabilityId: "GO-2020-0001",
            ecosystem: "Go",
            packageName: "github.com/gin-gonic/gin",
            purl: "pkg:golang/github.com/gin-gonic/gin",
            fixedVersion: "1.6.0",
        });
    });

    it("should extract multiple affected entries", () => {
        const raw = {
            id: "TEST-MULTI",
            affected: [
                { package: { name: "pkg-a", ecosystem: "npm", purl: "pkg:npm/pkg-a" } },
                { package: { name: "pkg-b", ecosystem: "npm", purl: "pkg:npm/pkg-b" } },
            ],
        };

        const rows = extractAffectedPackages("TEST-MULTI", raw);
        expect(rows).toHaveLength(2);
        expect(rows[0]?.packageName).toBe("pkg-a");
        expect(rows[1]?.packageName).toBe("pkg-b");
    });

    it("should skip affected entry without package.name", () => {
        const raw = {
            id: "CVE-GIT-ONLY",
            affected: [
                {
                    ranges: [{ type: "GIT", events: [{ introduced: "abc123" }, { fixed: "def456" }] }],
                },
            ],
        };

        const rows = extractAffectedPackages("CVE-GIT-ONLY", raw);
        expect(rows).toHaveLength(0);
    });

    it("should handle OSV record with no affected array", () => {
        expect(extractAffectedPackages("NO-AFFECTED", { id: "NO-AFFECTED" })).toHaveLength(0);
    });

    it("should handle null/undefined input", () => {
        expect(extractAffectedPackages("NULL", null)).toHaveLength(0);
        expect(extractAffectedPackages("UNDEF", undefined)).toHaveLength(0);
    });

    it("should extract explicit versions list", () => {
        const raw = {
            id: "TEST-VERSIONS",
            affected: [
                {
                    package: { name: "example-package", ecosystem: "npm", purl: "pkg:npm/example-package" },
                    ranges: [{ type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.0" }] }],
                    versions: ["1.0.0", "1.0.1", "1.1.0"],
                },
            ],
        };

        const rows = extractAffectedPackages("TEST-VERSIONS", raw);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.versions).toEqual(["1.0.0", "1.0.1", "1.1.0"]);
    });

    it("should extract fixedVersion from first fixed event in ranges", () => {
        const raw = {
            id: "TEST-FIX",
            affected: [
                {
                    package: { name: "test-pkg", ecosystem: "npm" },
                    ranges: [
                        {
                            type: "SEMVER",
                            events: [
                                { introduced: "0" },
                                { fixed: "2.5.0" },
                                { introduced: "3.0.0" },
                                { fixed: "3.1.0" },
                            ],
                        },
                    ],
                },
            ],
        };

        const rows = extractAffectedPackages("TEST-FIX", raw);
        expect(rows[0]?.fixedVersion).toBe("2.5.0");
    });

    // PYSEC advisories list the GIT range first, so an unfiltered "first fixed"
    // returned the commit hash and shadowed the real answer. Shape copied from
    // the django advisories in the mirror.
    it("should skip GIT ranges when extracting fixedVersion", () => {
        const raw = {
            id: "TEST-GIT-FIX",
            affected: [
                {
                    package: { name: "django", ecosystem: "PyPI" },
                    ranges: [
                        {
                            type: "GIT",
                            repo: "https://github.com/django/django",
                            events: [{ introduced: "0" }, { fixed: "67b46ba7016da2d259c1ecc7d666d11f5e1cfaab" }],
                        },
                        {
                            type: "ECOSYSTEM",
                            events: [
                                { introduced: "0" },
                                { fixed: "1.8.10" },
                                { introduced: "1.9" },
                                { fixed: "1.9.3" },
                            ],
                        },
                    ],
                },
            ],
        };

        const rows = extractAffectedPackages("TEST-GIT-FIX", raw);
        expect(rows[0]?.fixedVersion).toBe("1.8.10");
    });

    it("should leave fixedVersion null when only GIT ranges carry a fix", () => {
        const raw = {
            id: "TEST-GIT-ONLY",
            affected: [
                {
                    package: { name: "lcms", ecosystem: "OSS-Fuzz" },
                    ranges: [
                        {
                            type: "GIT",
                            repo: "https://github.com/mm2/Little-CMS",
                            events: [{ introduced: "0" }, { fixed: "76d1dccf3e5ce0c67125964d0908b322e7d1afb9" }],
                        },
                    ],
                },
            ],
        };

        const rows = extractAffectedPackages("TEST-GIT-ONLY", raw);
        expect(rows[0]?.fixedVersion).toBeNull();
    });

    it("should set a null purl when no PURL is provided", () => {
        const raw = {
            id: "NO-PURL",
            affected: [
                {
                    package: { name: "some-pkg", ecosystem: "npm" },
                },
            ],
        };

        const rows = extractAffectedPackages("NO-PURL", raw);
        expect(rows[0]?.purl).toBeNull();
    });
});

describe("extractAffectedPackages — match key and scoping columns", () => {
    it("should compute match_key from the affected entry's PURL", () => {
        const raw = {
            id: "TEST-KEY",
            affected: [
                {
                    package: {
                        name: "zope.interface",
                        ecosystem: "PyPI",
                        purl: "pkg:pypi/zope-interface",
                    },
                },
            ],
        };

        expect(extractAffectedPackages("TEST-KEY", raw)[0]?.matchKey).toBe("pypi|zope-interface");
    });

    it("should strip qualifiers from the PURL before keying", () => {
        // OSV's distro purls carry ?arch=source; the component's will carry
        // ?distro=… instead. Neither may reach the key.
        const raw = {
            id: "TEST-QUALIFIERS",
            affected: [
                {
                    package: {
                        name: "apache2",
                        ecosystem: "Alpine:v3.23",
                        purl: "pkg:apk/alpine/apache2?arch=source",
                    },
                },
            ],
        };

        expect(extractAffectedPackages("TEST-QUALIFIERS", raw)[0]?.matchKey).toBe("apk/alpine|apache2");
    });

    it("should fall back to ecosystem + package name when the PURL is absent", () => {
        // The fallback must land on the same key the purl would have produced,
        // or a record missing its purl silently stops matching.
        const withPurl = {
            id: "WITH-PURL",
            affected: [
                {
                    package: {
                        name: "org.apache.logging.log4j:log4j-core",
                        ecosystem: "Maven",
                        purl: "pkg:maven/org.apache.logging.log4j/log4j-core",
                    },
                },
            ],
        };
        const withoutPurl = {
            id: "WITHOUT-PURL",
            affected: [
                {
                    package: {
                        name: "org.apache.logging.log4j:log4j-core",
                        ecosystem: "Maven",
                    },
                },
            ],
        };

        const key = extractAffectedPackages("WITH-PURL", withPurl)[0]?.matchKey;
        expect(key).toBe("maven|org.apache.logging.log4j:log4j-core");
        expect(extractAffectedPackages("WITHOUT-PURL", withoutPurl)[0]?.matchKey).toBe(key);
    });

    it("should emit an unmatchable key for an ecosystem outside the table", () => {
        const raw = {
            id: "OSV-2021-1",
            affected: [{ package: { name: "some-fuzz-target", ecosystem: "OSS-Fuzz" } }],
        };

        // `?` cannot occur in a PURL type, so no component key can equal this.
        expect(extractAffectedPackages("OSV-2021-1", raw)[0]?.matchKey).toBe("?OSS-Fuzz|some-fuzz-target");
    });

    it("should split the ecosystem into family and release", () => {
        const raw = {
            id: "RHSA-TEST",
            affected: [
                {
                    package: {
                        name: "openssl",
                        ecosystem: "Red Hat:enterprise_linux:8::appstream",
                        purl: "pkg:rpm/redhat/openssl",
                    },
                },
            ],
        };

        expect(extractAffectedPackages("RHSA-TEST", raw)[0]).toMatchObject({
            ecosystem: "Red Hat:enterprise_linux:8::appstream",
            ecosystemFamily: "Red Hat",
            ecosystemRelease: "enterprise_linux:8::appstream",
        });
    });

    it("should leave the release null for a suffix-less ecosystem", () => {
        const raw = {
            id: "TEST-NO-RELEASE",
            affected: [{ package: { name: "lodash", ecosystem: "npm", purl: "pkg:npm/lodash" } }],
        };

        expect(extractAffectedPackages("TEST-NO-RELEASE", raw)[0]).toMatchObject({
            ecosystemFamily: "npm",
            ecosystemRelease: null,
        });
    });
});

describe("extractAffectedPackages — withdrawn flag", () => {
    const affected = [{ package: { name: "lodash", ecosystem: "npm", purl: "pkg:npm/lodash" } }];

    it("should default to false for an active advisory", () => {
        expect(extractAffectedPackages("ACTIVE", { id: "ACTIVE", affected })[0]?.withdrawn).toBe(false);
    });

    it("should flag every row of a withdrawn advisory", () => {
        const raw = {
            id: "WITHDRAWN",
            withdrawn: "2024-08-15T14:30:00Z",
            affected: [...affected, { package: { name: "underscore", ecosystem: "npm", purl: "pkg:npm/underscore" } }],
        };

        const rows = extractAffectedPackages("WITHDRAWN", raw);
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.withdrawn === true)).toBe(true);
    });

    it("should treat an unparseable withdrawn timestamp the same way the vulnerability row does", () => {
        // parseOsvJson drops an invalid timestamp, leaving withdrawn_at NULL.
        // The denormalized flag must agree, or the two disagree with no query
        // that can explain why.
        const raw = { id: "BAD-WITHDRAWN", withdrawn: "not-a-date", affected };

        expect(extractAffectedPackages("BAD-WITHDRAWN", raw)[0]?.withdrawn).toBe(false);
    });
});
