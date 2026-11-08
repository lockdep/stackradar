import { describe, expect, it } from "vitest";
import { FINDINGS_CSV_COLUMNS, findingsCsv, findingsCsvFilename } from "../../../src/lib/findings-csv.js";
import type { FindingExportRow } from "../../../src/repositories/vulnerability.repository.js";

function row(overrides: Partial<FindingExportRow> = {}): FindingExportRow {
    return {
        identity: "CVE-2024-0001",
        vulnId: "GHSA-xxxx-yyyy-zzzz",
        summary: "Prototype pollution in lodash",
        severityLevel: "critical",
        cvssScore: 9.8,
        epssScore: 0.9731,
        kevListedAt: new Date("2024-03-01T00:00:00Z"),
        kevDueDate: new Date("2024-03-22T00:00:00Z"),
        riskScore: 97.4,
        publishedAt: new Date("2024-02-10T12:00:00Z"),
        packageName: "lodash",
        packageVersion: "4.17.20",
        fixedVersion: "4.17.21",
        purl: "pkg:npm/lodash@4.17.20",
        bucket: "application",
        clusterName: "prod-eu",
        registry: "ghcr.io",
        repository: "acme/api",
        digest: "sha256:" + "a".repeat(64),
        namespaces: ["payments", "web"],
        ...overrides,
    };
}

function lines(csv: string): string[] {
    return csv
        .replace(/^\uFEFF/, "")
        .split("\r\n")
        .filter(Boolean);
}

describe("findingsCsv", () => {
    it("writes the header from the column list and one line per finding", () => {
        const [header, first, ...rest] = lines(findingsCsv([row()]));
        expect(header).toBe(FINDINGS_CSV_COLUMNS.join(","));
        expect(first).toBe(
            [
                "CVE-2024-0001",
                "critical",
                "9.8",
                "0.9731",
                "true",
                "2024-03-22",
                "97",
                "lodash",
                "4.17.20",
                "4.17.21",
                "npm",
                "application",
                "prod-eu",
                "ghcr.io/acme/api",
                "sha256:" + "a".repeat(64),
                "payments;web",
                "2024-02-10",
                "GHSA-xxxx-yyyy-zzzz",
                "Prototype pollution in lodash",
            ].join(","),
        );
        expect(rest).toEqual([]);
    });

    it("spells a stand-alone identity without its marker, an off-band severity as unscored and an unknown bucket as unclassified", () => {
        const [, line] = lines(
            findingsCsv([
                row({
                    identity: "#GHSA-aaaa-bbbb-cccc",
                    vulnId: "GHSA-aaaa-bbbb-cccc",
                    severityLevel: "unknown",
                    cvssScore: null,
                    epssScore: null,
                    kevListedAt: null,
                    kevDueDate: null,
                    riskScore: null,
                    publishedAt: null,
                    fixedVersion: null,
                    purl: null,
                    bucket: "unknown",
                    registry: null,
                    namespaces: [],
                    summary: null,
                }),
            ]),
        );
        expect(line).toBe(
            `GHSA-aaaa-bbbb-cccc,unscored,,,false,,,lodash,4.17.20,,,unclassified,prod-eu,acme/api,sha256:${"a".repeat(64)},,,GHSA-aaaa-bbbb-cccc,`,
        );
    });

    it("quotes a summary with a comma and marks a package name that reads as a formula", () => {
        const [, line] = lines(
            findingsCsv([row({ summary: 'Heap overflow, see "notes"', packageName: "=cmd", purl: null })]),
        );
        expect(line).toContain(",'=cmd,");
        expect(line!.endsWith(',"Heap overflow, see ""notes"""')).toBe(true);
    });
});

describe("findingsCsvFilename", () => {
    const day = new Date("2026-11-08T09:30:00Z");

    it("names the file by the scope and the day", () => {
        expect(findingsCsvFilename("acme-corp", day)).toBe("stackradar-findings-acme-corp-2026-11-08.csv");
        expect(findingsCsvFilename("nginx-abcdef12", day)).toBe("stackradar-findings-nginx-abcdef12-2026-11-08.csv");
    });

    it("reduces a cluster name to filename-safe characters, and falls back when nothing survives", () => {
        expect(findingsCsvFilename("prod EU / west", day)).toBe("stackradar-findings-prod-EU-west-2026-11-08.csv");
        expect(findingsCsvFilename("///", day)).toBe("stackradar-findings-all-2026-11-08.csv");
    });
});
