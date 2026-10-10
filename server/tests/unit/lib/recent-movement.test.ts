/**
 * `collectArrivals` — the findings behind one "New on running images" row.
 * Newest event wins on each finding key; a move contributes its from-image
 * for the caller to diff; the row's exclusions (first scan, digest gone) apply.
 */

import { describe, it, expect } from "vitest";
import { collectArrivals, byArrivalOrder, foldMovement, lensArrivals, type ArrivedFinding } from "../../../src/lib/recent-movement.js";
import type { ActivityEvent } from "../../../src/db/schema/remediation.js";

const HOUR = 60 * 60 * 1000;
const IMAGE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const bands = (critical = 0, high = 0, medium = 0, low = 0, unscored = 0) => ({ critical, high, medium, low, unscored });

let seq = 0;
function event(type: ActivityEvent["type"], ageMs: number, payload: Record<string, unknown>, imageId = IMAGE): ActivityEvent {
    return {
        id: `e${++seq}`,
        orgId: "org",
        clusterId: "cluster",
        type,
        imageId,
        issueId: null,
        payload,
        createdAt: new Date(Date.now() - ageMs),
    } as ActivityEvent;
}

const head = (vulnId: string, severityLevel: string, extra: Partial<ArrivedFinding> = {}) => ({
    key: `deb|${extra.packageName ?? "openssl"}|${vulnId}`,
    vulnId,
    packageName: extra.packageName ?? "openssl",
    packageType: "deb",
    packageVersion: "3.0.1",
    severityLevel,
    riskScore: extra.riskScore ?? 10,
    kevListed: extra.kevListed ?? false,
    fixedVersion: null,
});

describe("collectArrivals", () => {
    it("lists scan arrivals once, letting the newest event decide a key", () => {
        const events = [
            // Monday: two arrive.
            event("scan.findings-changed", 72 * HOUR, {
                cause: "mirror",
                containerCount: 2,
                addedBySeverity: bands(1, 1),
                added: [head("CVE-2026-0001", "critical", { kevListed: true }), head("CVE-2026-0002", "high")],
                removed: [],
            }),
            // Thursday: one is withdrawn, one re-arrives re-scored.
            event("scan.findings-changed", 6 * HOUR, {
                cause: "mirror",
                containerCount: 2,
                addedBySeverity: bands(0, 0, 1),
                removedBySeverity: bands(0, 1),
                added: [head("CVE-2026-0001", "medium", { kevListed: true })],
                removed: [head("CVE-2026-0002", "high")],
            }),
            // Not this image.
            event("scan.findings-changed", 1 * HOUR, { cause: "mirror", addedBySeverity: bands(3), added: [head("CVE-2026-0009", "critical")], removed: [] }, OTHER),
        ];

        const out = collectArrivals(events, IMAGE);
        expect(out.gone).toBe(false);
        expect(out.truncated).toBe(false);
        expect(out.moveFrom).toEqual([]);
        expect(out.findings.map((f) => [f.vulnId, f.severityLevel, f.via])).toEqual([["CVE-2026-0001", "medium", "scan"]]);
    });

    it("skips first scans and unscored arrivals, and flags a head list shorter than the count", () => {
        const events = [
            event("scan.findings-changed", 5 * HOUR, {
                cause: "first-scan",
                addedBySeverity: bands(4),
                added: [head("CVE-2026-0100", "critical")],
                removed: [],
            }),
            event("scan.findings-changed", 4 * HOUR, {
                cause: "mirror",
                addedBySeverity: bands(2, 0, 0, 0, 1),
                added: [head("CVE-2026-0101", "critical"), head("CVE-2026-0102", "unknown")],
                removed: [],
            }),
        ];
        const out = collectArrivals(events, IMAGE);
        expect(out.findings.map((f) => f.vulnId)).toEqual(["CVE-2026-0101"]);
        expect(out.truncated).toBe(true);
    });

    it("hands back the from-image of each measured move, distinct, and ignores unmeasured ones", () => {
        const from = (id: string) => ({ from: { imageId: id, digest: "sha256:a", tag: "1", ref: "r" } });
        const events = [
            event("container.image-changed", 3 * HOUR, { ...from("A"), delta: { introducedBySeverity: bands(0, 2) } }),
            event("container.image-changed", 2 * HOUR, { ...from("A"), delta: { introducedBySeverity: bands(0, 2) } }),
            event("container.image-changed", 1 * HOUR, { ...from("B"), delta: null, deltaUnavailable: "from-unscanned" }),
            event("container.image-changed", 1 * HOUR, { ...from("C"), delta: { introducedBySeverity: bands() } }),
        ];
        expect(collectArrivals(events, IMAGE).moveFrom).toEqual(["A"]);
    });

    it("is empty when the newest scan says nothing runs the digest any more", () => {
        const events = [
            event("scan.findings-changed", 2 * HOUR, { cause: "mirror", containerCount: 0, addedBySeverity: bands(1), added: [head("CVE-2026-0200", "critical")], removed: [] }),
            event("scan.findings-changed", 8 * HOUR, { cause: "mirror", containerCount: 1, addedBySeverity: bands(1), added: [head("CVE-2026-0201", "critical")], removed: [] }),
        ];
        expect(collectArrivals(events, IMAGE)).toEqual({ findings: [], truncated: false, moveFrom: [], gone: true });
    });

    it("orders by band, then KEV, then risk", () => {
        const rows: ArrivedFinding[] = [
            { ...head("CVE-1", "high", { riskScore: 50 }), via: "scan", bucket: null, exploited: false },
            { ...head("CVE-2", "critical", { riskScore: 20 }), via: "move", bucket: null, exploited: false },
            { ...head("CVE-3", "high", { riskScore: 30, kevListed: true }), via: "scan", bucket: null, exploited: false },
            { ...head("CVE-4", "critical", { riskScore: 40 }), via: "scan", bucket: null, exploited: false },
            { ...head("CVE-5", "unknown", { riskScore: 90 }), via: "scan", bucket: null, exploited: false },
        ];
        expect([...rows].sort(byArrivalOrder).map((f) => f.vulnId)).toEqual(["CVE-4", "CVE-2", "CVE-3", "CVE-1", "CVE-5"]);
    });
});

describe("the tier lens over movement", () => {
    const appBands = { application: bands(0, 1), base: bands(1) };

    it("orders images worst first, recency only breaking a tie", () => {
        const now = new Date();
        const since = new Date(now.getTime() - 7 * 24 * HOUR);
        const events = [
            // The older image is the worse one, so it leads.
            event("scan.findings-changed", 30 * HOUR, {
                cause: "mirror", containerCount: 1, addedBySeverity: bands(3), added: [], removed: [],
            }),
            event("scan.findings-changed", 2 * HOUR, {
                cause: "mirror", containerCount: 1, addedBySeverity: bands(0, 0, 0, 1), added: [], removed: [],
            }, OTHER),
        ];

        expect(foldMovement(events, since, now).images.map((i) => i.imageId)).toEqual([IMAGE, OTHER]);
    });

    it("breaks a tie on what arrived by the newest arrival", () => {
        const now = new Date();
        const since = new Date(now.getTime() - 7 * 24 * HOUR);
        const high = { cause: "mirror", containerCount: 1, addedBySeverity: bands(0, 1), added: [], removed: [] };
        const events = [
            event("scan.findings-changed", 30 * HOUR, high),
            event("scan.findings-changed", 2 * HOUR, high, OTHER),
        ];

        expect(foldMovement(events, since, now).images.map((i) => i.imageId)).toEqual([OTHER, IMAGE]);
    });

    it("counts a lensed event by its per-lens breakdown and an older event whole", () => {
        const now = new Date();
        const since = new Date(now.getTime() - 7 * 24 * HOUR);
        const events = [
            // Written since the lens: 1 critical in the base, 1 high in the application.
            event("scan.findings-changed", 4 * HOUR, {
                cause: "mirror", containerCount: 1, addedBySeverity: bands(1, 1), addedByLens: appBands, added: [], removed: [],
            }),
            // Older than the lens: no breakdown, so it counts under every lens.
            event("scan.findings-changed", 30 * HOUR, {
                cause: "mirror", containerCount: 1, addedBySeverity: bands(0, 0, 2), added: [], removed: [],
            }, OTHER),
        ];

        const all = foldMovement(events, since, now);
        expect(all.images.map((i) => i.addedCount)).toEqual([2, 2]);
        expect(all.tierCounts).toEqual({ application: 3, base: 3, all: 4 });

        const application = foldMovement(events, since, now, ["application"]);
        expect(application.images.find((i) => i.imageId === IMAGE)?.added).toEqual(bands(0, 1));
        expect(application.images.find((i) => i.imageId === OTHER)?.addedCount).toBe(2);
        expect(application.tierCounts).toEqual(all.tierCounts);
    });

    it("drops an image whose arrivals are all outside the lens", () => {
        const now = new Date();
        const events = [
            event("container.image-changed", 2 * HOUR, {
                from: { imageId: "A" }, to: { imageId: IMAGE },
                delta: { introducedBySeverity: bands(0, 3), introducedByLens: { application: bands(), base: bands(0, 3) } },
            }),
        ];
        expect(foldMovement(events, new Date(0), now, ["application"]).images).toEqual([]);
        expect(foldMovement(events, new Date(0), now, ["base"]).images).toHaveLength(1);
    });

    it("keeps an exploited base finding under the application lens, marked", () => {
        const rows: ArrivedFinding[] = [
            { ...head("CVE-1", "high"), via: "scan", bucket: "application", exploited: false },
            { ...head("CVE-2", "high"), via: "scan", bucket: "base", exploited: false },
            { ...head("CVE-3", "medium", { kevListed: true }), via: "scan", bucket: "base", exploited: true },
            { ...head("CVE-4", "low"), via: "scan", bucket: null, exploited: false },
        ];
        const lensed = lensArrivals(rows, ["application"]);
        expect(lensed.findings.map((f) => [f.vulnId, f.shownDespiteTier])).toEqual([
            ["CVE-1", false],
            ["CVE-3", true],
            ["CVE-4", false],
        ]);
        expect(lensed.tierCounts).toEqual({ application: 1, base: 2, all: 4 });
    });
});
