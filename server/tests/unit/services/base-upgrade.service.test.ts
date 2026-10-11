/**
 * `services/base-upgrade.service.ts` — the pure parts: which base refs are
 * worth asking about, which newer tag to propose, and what a rebuild buys.
 */

import { describe, it, expect } from "vitest";
import { measureCandidate, parseBaseRef, pickNewerTag } from "../../../src/services/base-upgrade.service.js";
import type { ComparableFinding } from "../../../src/db/finding-delta.js";

const finding = (
    vulnId: string,
    pkg: string,
    bucket: ComparableFinding["bucket"],
    extra: Partial<ComparableFinding> = {},
): ComparableFinding => ({
    key: `library|${pkg}|${vulnId}`,
    vulnId,
    packageName: pkg,
    packageType: "library",
    purlType: bucket === "base" ? "deb" : "npm",
    packageVersion: "1.0.0",
    severityLevel: "medium",
    riskScore: 10,
    kevListed: false,
    epssScore: null,
    fixedVersion: null,
    bucket,
    ...extra,
});

describe("parseBaseRef", () => {
    it("canonicalises a Docker Hub official image", () => {
        expect(parseBaseRef("node:20-bookworm-slim")).toEqual({
            registry: "docker.io",
            repository: "library/node",
            tag: "20-bookworm-slim",
        });
        expect(parseBaseRef("docker.io/library/node:20-bookworm-slim")).toEqual(parseBaseRef("node:20-bookworm-slim"));
        expect(parseBaseRef("gcr.io/distroless/static-debian12:nonroot")).toMatchObject({
            registry: "gcr.io",
            tag: "nonroot",
        });
    });

    it("refuses what no public registry can be asked about", () => {
        expect(parseBaseRef(null)).toBeNull();
        expect(parseBaseRef("registry.corp.example/base/node:20")).toBeNull();
        expect(parseBaseRef("node@sha256:" + "a".repeat(64))).toBeNull();
    });
});

describe("pickNewerTag", () => {
    const tags = [
        "20.11.1-bookworm-slim",
        "20.18.0-bookworm-slim",
        "20.18.1-bookworm-slim",
        "22.11.0-bookworm-slim",
        "20.18.1-alpine3.20",
        "20-bookworm-slim",
        "latest",
    ];

    it("prefers the newest comparable tag in the same major", () => {
        expect(pickNewerTag("20.11.1-bookworm-slim", tags)).toMatchObject({
            tag: "20.18.1-bookworm-slim",
            availability: "available",
        });
    });

    it("crosses a major only when the line has nothing newer", () => {
        expect(pickNewerTag("20.18.1-bookworm-slim", tags)).toMatchObject({
            tag: "22.11.0-bookworm-slim",
            availability: "available",
        });
    });

    it("never changes the variant", () => {
        expect(pickNewerTag("20.18.1-alpine3.20", tags)).toMatchObject({ tag: null, availability: "up-to-date" });
    });

    it("says ordering is ambiguous for a tag that is not a version", () => {
        expect(pickNewerTag("latest", tags)).toMatchObject({ tag: null, availability: "ambiguous-ordering" });
    });
});

describe("measureCandidate", () => {
    const image = [
        finding("CVE-1", "openssl", "base", { kevListed: true, severityLevel: "critical", riskScore: 90 }),
        finding("CVE-2", "zlib", "base", { riskScore: 20 }),
        finding("CVE-3", "glibc", "base", { riskScore: 5 }),
        finding("CVE-4", "lodash", "application", { riskScore: 40 }),
    ];

    it("counts removals among the image's base findings only", () => {
        // The newer base still has the glibc finding, and brings one of its own.
        const candidate = [finding("CVE-3", "glibc", "base"), finding("CVE-9", "curl", "base", { riskScore: 7 })];
        expect(measureCandidate(image, candidate)).toEqual({
            baseFindings: 3,
            removes: 2,
            removesKev: 1,
            removesHigh: 1,
            introduces: 1,
            riskRemoved: 90 + 20 - 7,
        });
    });

    it("never counts an application finding as removed by a base rebuild", () => {
        expect(measureCandidate(image, []).removes).toBe(3);
        expect(measureCandidate([finding("CVE-4", "lodash", "application")], []).removes).toBe(0);
    });
});
