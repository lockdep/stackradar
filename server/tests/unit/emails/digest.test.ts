import { describe, it, expect } from "vitest";
import { renderDigestEmail, type DigestEmailInput } from "../../../src/cloud/alerting/digest-email.js";
import { baseImageArrivals } from "../../../src/lib/since-summary.js";
import type { ActivityEvent } from "../../../src/db/schema/remediation.js";

const base: DigestEmailInput = {
    orgName: "Acme",
    name: "Ada",
    week: "2026-W38",
    radarScore: 1240,
    radarScoreWeekAgo: 1300,
    findingCount: 243,
    topFindings: [
        {
            vulnId: "CVE-2024-1001",
            packageName: "lodash",
            packageVersion: "4.17.20",
            fixedVersion: "4.17.21",
            risk: 61,
            kev: false,
            epssScore: 0.02,
            imageLabel: "registry.corp.example/team/api:2.1.0",
            imageId: "11111111-1111-4111-8111-111111111111",
            clusterName: "prod",
            workloadCount: 1,
            containerCount: 2,
        },
    ],
    upstream: { chartUpgrades: 3, imageUpgrades: 0, findingsRemoved: 412, waitingImages: 5 },
    startHereScope: "application",
    baseImageArrivals: { findings: 41, images: 6 },
    baseImageFindings: 231,
    baseRebuilds: null,
    newKevVulnIds: [],
    newFindings: 47,
    resolvedFindings: 12,
    coverageProblems: [],
    appUrl: "https://app.test",
    unsubscribeUrl: "https://app.test/u",
};

describe("renderDigestEmail — the application section comes first", () => {
    it("leads with application findings and says the base image once, as a count", () => {
        const email = renderDigestEmail(base);
        const start = email.text.indexOf("Start here — in the application packages of images you control");
        const baseLine = email.text.indexOf("Base images: 41 new across 6 images this week; 231 findings are in base images.");
        expect(start).toBeGreaterThan(-1);
        expect(baseLine).toBeGreaterThan(start);
        expect(email.text).toContain("CVE-2024-1001");
        expect(email.html).toContain("Base images: 41 new across 6 images this week");
        // No base-image rows: until a rebuild can be recommended, a row is a problem with no move attached.
        expect(email.text.match(/\/100 {2}/g)).toHaveLength(1);
    });

    it("makes the base line actionable once a rebuild has been measured", () => {
        const email = renderDigestEmail({ ...base, baseRebuilds: { count: 2, findingsRemoved: 212 } });
        expect(email.text).toContain("231 findings are in base images. 2 rebuilds on a newer base would remove 212 of them. Exploited ones are listed above.");
    });

    it("says what is waiting on someone else in one line", () => {
        const email = renderDigestEmail(base);
        expect(email.text).toContain("Upstream: 3 chart upgrades available (removes 412 findings), 5 images waiting on upstream. https://app.test/fixes");
        expect(renderDigestEmail({ ...base, upstream: null }).text).not.toContain("Upstream:");
        expect(renderDigestEmail({ ...base, upstream: { chartUpgrades: 0, imageUpgrades: 0, findingsRemoved: 0, waitingImages: 0 } }).text).not.toContain("Upstream:");
    });

    it("never says tier, os or runtime", () => {
        const email = renderDigestEmail(base);
        expect(`${email.text}\n${email.html}`).not.toMatch(/\btier\b|\bruntime\b/i);
    });

    it("says nothing is the application's, rather than nothing at all, when only the base has findings", () => {
        const email = renderDigestEmail({ ...base, topFindings: [], baseImageArrivals: { findings: 0, images: 0 } });
        expect(email.text).toContain("Start here: nothing in your application packages.");
        expect(email.text).toContain("Base images: 231 findings are in base images; none arrived this week.");
    });

    it("omits the base line when there is nothing in it", () => {
        const email = renderDigestEmail({ ...base, topFindings: [], baseImageArrivals: { findings: 0, images: 0 }, baseImageFindings: 0 });
        expect(email.text).toContain("Start here: nothing — no confirmed findings in your scanned images.");
        expect(email.text).not.toContain("Base images:");
    });
});

describe("baseImageArrivals", () => {
    const event = (type: ActivityEvent["type"], imageId: string, payload: Record<string, unknown>) =>
        ({ id: imageId + type, orgId: "o", clusterId: "c", type, imageId, issueId: null, payload, createdAt: new Date() }) as ActivityEvent;

    it("sums the per-bucket counts events carry, per distinct image", () => {
        const result = baseImageArrivals([
            event("scan.findings-changed", "a", { cause: "mirror", containerCount: 2, addedByBucket: { application: 3, base: 30, unknown: 0 } }),
            event("scan.findings-changed", "a", { cause: "mirror", containerCount: 2, addedByBucket: { application: 0, base: 5, unknown: 0 } }),
            event("container.image-changed", "b", { delta: { introducedByBucket: { application: 1, base: 6, unknown: 0 } } }),
            // First scans are inventory; a digest nothing runs is not running; an older event says nothing.
            event("scan.findings-changed", "c", { cause: "first-scan", containerCount: 1, addedByBucket: { application: 0, base: 99, unknown: 0 } }),
            event("scan.findings-changed", "d", { cause: "mirror", containerCount: 0, addedByBucket: { application: 0, base: 99, unknown: 0 } }),
            event("scan.findings-changed", "e", { cause: "mirror", containerCount: 1, addedBySeverity: { critical: 9 } }),
        ]);
        expect(result).toEqual({ findings: 41, images: 2 });
    });
});
