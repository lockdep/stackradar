import { describe, it, expect } from "vitest";
import { validateCycloneDx, formatValidationErrors } from "../../../src/validators/cyclonedx.validator.js";

describe("validateCycloneDx", () => {
    describe("valid SBOMs", () => {
        it("should accept a minimal valid CycloneDX 1.6 SBOM", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it("should accept a full CycloneDX SBOM with components", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 1,
                serialNumber: "urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79",
                metadata: {
                    timestamp: "2024-01-01T00:00:00Z",
                    component: {
                        type: "application",
                        name: "my-app",
                        version: "1.0.0",
                    },
                },
                components: [
                    {
                        type: "library",
                        name: "lodash",
                        version: "4.17.21",
                        purl: "pkg:npm/lodash@4.17.21",
                    },
                ],
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });

    describe("invalid SBOMs", () => {
        it("should reject an empty object", () => {
            const result = validateCycloneDx({});

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
            // Should require bomFormat and specVersion
            expect(result.errors.some((e) => e.message?.includes("bomFormat"))).toBe(true);
        });

        it("should reject missing bomFormat", () => {
            const sbom = {
                specVersion: "1.6",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.message?.includes("bomFormat"))).toBe(true);
        });

        it("should reject missing specVersion", () => {
            const sbom = {
                bomFormat: "CycloneDX",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.message?.includes("specVersion"))).toBe(true);
        });

        it("should reject invalid bomFormat value", () => {
            const sbom = {
                bomFormat: "SPDX",
                specVersion: "1.6",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("bomFormat"))).toBe(true);
        });

        it("should reject version that is not an integer", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: "1.0", // Should be integer
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("version"))).toBe(true);
        });

        it("should reject version less than 1", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                version: 0,
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("version"))).toBe(true);
        });

        it("should reject invalid serialNumber format", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                serialNumber: "not-a-urn-uuid",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("serialNumber"))).toBe(true);
        });

        it("should reject invalid component type", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                components: [
                    {
                        type: "invalid-type",
                        name: "test",
                    },
                ],
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.path.includes("components"))).toBe(true);
        });

        it("should reject component without required name", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                components: [
                    {
                        type: "library",
                        // name is required but missing
                    },
                ],
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
        });

        it("should reject additional properties not in schema", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
                unknownProperty: "value",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => e.keyword === "additionalProperties")).toBe(true);
        });
    });

    describe("version support", () => {
        it("should reject specVersion 1.5 (only 1.6 supported)", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.5",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]!.path).toBe("/specVersion");
            expect(result.errors[0]!.message).toContain("1.5");
            expect(result.errors[0]!.message).toContain("1.6");
        });

        it("should reject specVersion 1.4 (only 1.6 supported)", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.4",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]!.path).toBe("/specVersion");
            expect(result.errors[0]!.message).toContain("1.4");
        });

        it("should reject specVersion 1.3 (only 1.6 supported)", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.3",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors[0]!.path).toBe("/specVersion");
            expect(result.errors[0]!.message).toContain("1.3");
        });

        it("should accept specVersion 1.6", () => {
            const sbom = {
                bomFormat: "CycloneDX",
                specVersion: "1.6",
            };

            const result = validateCycloneDx(sbom);

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });
    });
});

describe("formatValidationErrors", () => {
    it("should return 'No validation errors' for empty array", () => {
        const result = formatValidationErrors([]);
        expect(result).toBe("No validation errors");
    });

    it("should format a single error", () => {
        const errors = [
            {
                path: "/bomFormat",
                message: "must be equal to constant",
                keyword: "const",
                params: { allowedValue: "CycloneDX" },
            },
        ];

        const result = formatValidationErrors(errors);
        expect(result).toBe("/bomFormat: must be equal to constant");
    });

    it("should format multiple errors with count", () => {
        const errors = [
            { path: "/a", message: "error 1", keyword: "type", params: {} },
            { path: "/b", message: "error 2", keyword: "type", params: {} },
            { path: "/c", message: "error 3", keyword: "type", params: {} },
            { path: "/d", message: "error 4", keyword: "type", params: {} },
        ];

        const result = formatValidationErrors(errors);
        expect(result).toContain("/a: error 1");
        expect(result).toContain("/b: error 2");
        expect(result).toContain("/c: error 3");
        expect(result).toContain("1 more error");
    });
});
