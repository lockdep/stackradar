/**
 * OSV Validator Tests
 *
 * Tests the OSV schema validator both in isolation with synthetic data
 * and against real-world OSV sample fixtures.
 */

import { describe, it, expect } from "vitest";
import {
    validateOsv,
    formatOsvValidationErrors,
} from "../../../src/validators/osv.validator.js";
import {
    loadAllOsvSamples,
    loadSchemaValidSamples,
    loadSchemaInvalidSamples,
    type OsvSampleFixture,
} from "../../fixtures/osv-fixture-loader.js";

describe("validateOsv", () => {
    describe("valid records", () => {
        it("should accept a minimal valid OSV record", () => {
            const record = {
                id: "GHSA-test-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should accept a full OSV record with affected packages", () => {
            const record = {
                id: "GHSA-test-0002",
                modified: "2024-06-01T12:00:00Z",
                published: "2024-05-30T10:00:00Z",
                summary: "Test advisory",
                details: "Detailed description of the vulnerability.",
                affected: [
                    {
                        package: {
                            ecosystem: "npm",
                            name: "test-package",
                        },
                        ranges: [
                            {
                                type: "SEMVER",
                                events: [
                                    { introduced: "0" },
                                    { fixed: "1.2.3" },
                                ],
                            },
                        ],
                    },
                ],
                references: [
                    {
                        type: "ADVISORY",
                        url: "https://example.com/advisory/1",
                    },
                ],
                severity: [
                    {
                        type: "CVSS_V3",
                        score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
                    },
                ],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should accept a record with withdrawn field", () => {
            const record = {
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                withdrawn: "2024-06-01T10:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe("invalid records", () => {
        it("should reject an empty object", () => {
            const result = validateOsv({});

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it("should reject a record missing id", () => {
            const record = {
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.message?.includes("id"))).toBe(true);
        });

        it("should reject a record missing modified", () => {
            const record = {
                id: "CVE-2024-0001",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.message?.includes("modified"))).toBe(true);
        });

        it("should reject a record with an unrecognized id prefix", () => {
            const record = {
                id: "UNKNOWN-001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("id"))).toBe(true);
        });

        it("should reject an invalid severity type", () => {
            const record = {
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [
                    {
                        type: "INVALID_TYPE",
                        score: "not-a-cvss",
                    },
                ],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("severity"))).toBe(true);
        });

        it("should reject an invalid range type", () => {
            const record = {
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                affected: [
                    {
                        package: {
                            ecosystem: "npm",
                            name: "test-package",
                        },
                        ranges: [
                            {
                                type: "INVALID",
                                events: [{ introduced: "0" }],
                            },
                        ],
                    },
                ],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("ranges"))).toBe(true);
        });
    });

    describe("Ubuntu severity normalization", () => {
        it("should accept an Ubuntu CVE with bare severity score (no type)", () => {
            const record = {
                id: "UBUNTU-CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [{ score: "medium" }],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should accept an Ubuntu CVE with mixed CVSS_V3 and bare Ubuntu score", () => {
            const record = {
                id: "UBUNTU-CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [
                    { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" },
                    { score: "high" },
                ],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should still accept an Ubuntu CVE with explicit type: Ubuntu", () => {
            const record = {
                id: "UBUNTU-CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [{ type: "Ubuntu", score: "medium" }],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should reject a non-Ubuntu CVE with bare severity score", () => {
            const record = {
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [{ score: "medium" }],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
        });

        it("should reject an Ubuntu CVE with an unrecognized bare score", () => {
            const record = {
                id: "UBUNTU-CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
                severity: [{ score: "unknown" }],
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
        });

        it.each(["negligible", "low", "medium", "high", "critical"])(
            "should accept Ubuntu bare score '%s'",
            (score) => {
                const record = {
                    id: "UBUNTU-CVE-2024-0001",
                    modified: "2024-06-01T12:00:00Z",
                    severity: [{ score }],
                };

                const result = validateOsv(record);

                expect(result.valid).toBe(true);
            }
        );
    });

    describe("version support", () => {
        it("should accept supported schema_version 1.7.3", () => {
            const record = {
                schema_version: "1.7.3",
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
        });

        it("should accept supported schema_version 1.6.0", () => {
            const record = {
                schema_version: "1.6.0",
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
        });

        it("should accept supported schema_version 1.5.0", () => {
            const record = {
                schema_version: "1.5.0",
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
        });

        it("should reject unsupported schema_version", () => {
            const record = {
                schema_version: "99.0.0",
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]!.path).toBe("/schema_version");
            expect(result.errors[0]!.message).toContain("99.0.0");
        });

        it("should accept records without schema_version (optional field)", () => {
            const record = {
                id: "CVE-2024-0001",
                modified: "2024-06-01T12:00:00Z",
            };

            const result = validateOsv(record);

            expect(result.valid).toBe(true);
        });
    });

    describe("real-world OSV samples", () => {
        const allSamples = loadAllOsvSamples();

        it.each(allSamples.map((s) => [s.id, s] as const))(
            "validates %s against the OSV schema",
            (_id, sample: OsvSampleFixture) => {
                const result = validateOsv(sample.json);

                expect(result.valid).toBe(sample.isSchemaValid);
                expect(result.errors).toEqual(sample.validationErrors);
            }
        );

        it("should have at least one schema-valid sample", () => {
            const valid = loadSchemaValidSamples();
            expect(valid.length).toBeGreaterThan(0);
        });
    });
});

describe("formatOsvValidationErrors", () => {
    it("should return 'No validation errors' for empty array", () => {
        const result = formatOsvValidationErrors([]);
        expect(result).toBe("No validation errors");
    });

    it("should format a single error", () => {
        const errors = [
            {
                path: "/id",
                message: "must have required property 'id'",
                keyword: "required",
                params: { missingProperty: "id" },
            },
        ];

        const result = formatOsvValidationErrors(errors);
        expect(result).toBe("/id: must have required property 'id'");
    });

    it("should format multiple errors with count", () => {
        const errors = [
            { path: "/a", message: "error 1", keyword: "type", params: {} },
            { path: "/b", message: "error 2", keyword: "type", params: {} },
            { path: "/c", message: "error 3", keyword: "type", params: {} },
            { path: "/d", message: "error 4", keyword: "type", params: {} },
        ];

        const result = formatOsvValidationErrors(errors);
        expect(result).toContain("/a: error 1");
        expect(result).toContain("/b: error 2");
        expect(result).toContain("/c: error 3");
        expect(result).toContain("1 more error");
    });

    it("should format exactly 3 errors without 'more' suffix", () => {
        const errors = [
            { path: "/a", message: "error 1", keyword: "type", params: {} },
            { path: "/b", message: "error 2", keyword: "type", params: {} },
            { path: "/c", message: "error 3", keyword: "type", params: {} },
        ];

        const result = formatOsvValidationErrors(errors);
        expect(result).toContain("/a: error 1");
        expect(result).toContain("/c: error 3");
        expect(result).not.toContain("more");
    });
});
