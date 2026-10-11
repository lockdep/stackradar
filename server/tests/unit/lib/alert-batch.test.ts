import { describe, it, expect } from "vitest";
import {
    buildAlertBatch,
    eventQualifies,
    findingReason,
    meetsSeverity,
    shouldSendNow,
    type AlertCriteria,
} from "../../../src/lib/alert-batch.js";
import type { ActivityEvent, ActivityEventType } from "../../../src/db/schema/remediation.js";

let seq = 0;
function event(
    type: ActivityEventType,
    payload: Record<string, unknown>,
    opts: { imageId?: string | null; clusterId?: string | null; ageMs?: number } = {},
): ActivityEvent {
    seq += 1;
    return {
        id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
        orgId: "org",
        clusterId: opts.clusterId === undefined ? "cluster-a" : opts.clusterId,
        type,
        imageId: opts.imageId === undefined ? `image-${seq}` : opts.imageId,
        issueId: null,
        payload,
        createdAt: new Date(Date.now() - (opts.ageMs ?? 0)),
    };
}

const critical = (vulnId: string, extra: Record<string, unknown> = {}) => ({
    vulnId,
    packageName: "openssl",
    packageVersion: "3.0.11",
    severityLevel: "critical",
    riskScore: 71,
    kevListed: false,
    fixedVersion: "3.0.12",
    ...extra,
});

function scan(payload: Record<string, unknown>, opts?: Parameters<typeof event>[2]) {
    return event(
        "scan.findings-changed",
        {
            cause: "mirror",
            repository: "ghcr.io/acme/api",
            digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            containerCount: 2,
            containers: [
                { namespace: "default", workloadName: "api", workloadKind: "Deployment", init: false },
                { namespace: "default", workloadName: "migrate", workloadKind: "Job", init: true },
            ],
            added: [],
            rescored: [],
            ...payload,
        },
        opts,
    );
}

describe("what qualifies", () => {
    it("a new critical or a new KEV finding on a running image does; a plain high does not", () => {
        expect(findingReason(critical("CVE-1"), "added")).toBe("new-critical");
        expect(findingReason(critical("CVE-1", { severityLevel: "high", kevListed: true }), "added")).toBe("new-kev");
        expect(findingReason(critical("CVE-1", { severityLevel: "high" }), "added")).toBeNull();
    });

    it("a rescore counts only when it moves into critical", () => {
        expect(findingReason(critical("CVE-1", { previousSeverityLevel: "high" }), "rescored")).toBe(
            "rescored-critical",
        );
        expect(findingReason(critical("CVE-1", { previousSeverityLevel: "critical" }), "rescored")).toBeNull();
        expect(
            findingReason(
                critical("CVE-1", { severityLevel: "high", previousSeverityLevel: "critical", kevListed: true }),
                "rescored",
            ),
        ).toBeNull();
    });

    it("a first scan is inventory, and an image nothing runs is nobody's problem", () => {
        expect(eventQualifies(scan({ added: [critical("CVE-1")] }))).toBe(true);
        expect(eventQualifies(scan({ cause: "first-scan", added: [critical("CVE-1")] }))).toBe(false);
        expect(eventQualifies(scan({ containerCount: 0, added: [critical("CVE-1")] }))).toBe(false);
        expect(eventQualifies(scan({ cause: "upload", added: [critical("CVE-1")] }))).toBe(true);
    });

    it("a deploy that ships a critical is not an alert — the Feed shows it", () => {
        expect(eventQualifies(event("container.image-changed", { delta: { introduced: 3, introducedKev: 1 } }))).toBe(
            false,
        );
        expect(eventQualifies(event("container.appeared", {}))).toBe(false);
    });

    it("follows the org's criteria: a high floor admits highs, `none` leaves only KEV, KEV off ignores listings", () => {
        const highFloor: AlertCriteria = { minSeverity: "high", kev: true };
        const kevOnly: AlertCriteria = { minSeverity: "none", kev: true };
        const severityOnly: AlertCriteria = { minSeverity: "critical", kev: false };

        expect(meetsSeverity("high", highFloor)).toBe(true);
        expect(meetsSeverity("medium", highFloor)).toBe(false);
        expect(meetsSeverity("critical", kevOnly)).toBe(false);

        const high = scan({ added: [critical("CVE-1", { severityLevel: "high" })] });
        expect(eventQualifies(high, highFloor)).toBe(true);
        expect(eventQualifies(high)).toBe(false);
        expect(eventQualifies(high, kevOnly)).toBe(false);

        const kevMedium = scan({ added: [critical("CVE-2", { severityLevel: "medium", kevListed: true })] });
        expect(eventQualifies(kevMedium, kevOnly)).toBe(true);
        expect(eventQualifies(kevMedium, severityOnly)).toBe(false);

        const listing = event(
            "finding.kev-listed",
            { vulnId: "CVE-3", images: [] },
            { imageId: null, clusterId: null },
        );
        expect(eventQualifies(listing, severityOnly)).toBe(false);
        expect(eventQualifies(listing, kevOnly)).toBe(true);

        // A rescore into the floor is news under that floor only.
        expect(
            findingReason(
                critical("CVE-4", { severityLevel: "high", previousSeverityLevel: "medium" }),
                "rescored",
                highFloor,
            ),
        ).toBe("rescored-critical");
        expect(
            findingReason(critical("CVE-4", { severityLevel: "high", previousSeverityLevel: "medium" }), "rescored"),
        ).toBeNull();

        expect(buildAlertBatch([high, kevMedium, listing], severityOnly).items).toEqual([]);
        expect(buildAlertBatch([high, kevMedium, listing], highFloor).items.map((i) => i.vulnId)).toEqual([
            "CVE-2",
            "CVE-3",
            "CVE-1",
        ]);
    });

    it("a KEV listing on something running always qualifies", () => {
        expect(
            eventQualifies(
                event("finding.kev-listed", { vulnId: "CVE-2", images: [] }, { imageId: null, clusterId: null }),
            ),
        ).toBe(true);
        expect(eventQualifies(event("finding.kev-listed", {}, { imageId: null, clusterId: null }))).toBe(false);
    });
});

describe("buildAlertBatch", () => {
    it("folds forty images of one CVE into one item, worst first, with the images it landed on", () => {
        const events = Array.from({ length: 40 }, (_, i) =>
            scan({
                repository: `ghcr.io/acme/svc-${i}`,
                containerCount: 1 + (i % 3),
                added: [critical("CVE-2026-1000")],
            }),
        );
        events.push(
            scan({
                repository: "ghcr.io/acme/db",
                added: [critical("CVE-2026-2000", { severityLevel: "high", kevListed: true, riskScore: 95 })],
            }),
        );

        const batch = buildAlertBatch(events);

        expect(batch.eventCount).toBe(41);
        expect(batch.items.map((i) => i.vulnId)).toEqual(["CVE-2026-2000", "CVE-2026-1000"]);
        const glibc = batch.items[1]!;
        expect(glibc.imageCount).toBe(40);
        expect(glibc.images).toHaveLength(10);
        // Busiest images first.
        expect(glibc.images[0]!.containerCount).toBe(3);
        expect(glibc.reason).toBe("new-critical");
        expect(glibc.packages).toEqual(["openssl@3.0.11"]);
        expect(glibc.fixedVersion).toBe("3.0.12");
        expect(glibc.eventIds).toHaveLength(40);
        // Init containers are not where the reader looks.
        expect(glibc.images[0]!.containers).toEqual(["default/api"]);
        expect(batch.items[0]!.reason).toBe("new-kev");
        expect(batch.items[0]!.kevListed).toBe(true);
    });

    it("the KEV listing is the strongest reason and carries its own image list", () => {
        const listing = event(
            "finding.kev-listed",
            {
                vulnId: "CVE-2026-1000",
                severityLevel: "high",
                riskScore: 88,
                packages: ["glibc@2.36"],
                imageCount: 2,
                images: [
                    {
                        imageId: "img-1",
                        repository: "ghcr.io/acme/api",
                        digest: null,
                        clusterId: "cluster-b",
                        containerCount: 4,
                        containers: [{ namespace: "prod", workloadName: "api" }],
                    },
                    {
                        imageId: "img-2",
                        repository: "ghcr.io/acme/web",
                        digest: null,
                        clusterId: "cluster-a",
                        containerCount: 1,
                        containers: [],
                    },
                ],
            },
            { imageId: null, clusterId: null },
        );
        const later = scan({ added: [critical("CVE-2026-1000", { kevListed: true })] });

        const [item] = buildAlertBatch([listing, later]).items;
        expect(item!.reason).toBe("kev-listed");
        expect(item!.kevListed).toBe(true);
        expect(item!.imageCount).toBe(3);
        expect(item!.clusterIds.sort()).toEqual(["cluster-a", "cluster-b"]);
        expect(item!.images[0]!.imageId).toBe("img-1");
        expect(item!.packages).toContain("glibc@2.36");
        expect(item!.eventIds).toHaveLength(2);
    });

    it("ignores the events that do not qualify even when handed the raw window", () => {
        const batch = buildAlertBatch([
            scan({ cause: "first-scan", added: [critical("CVE-1")] }),
            scan({ added: [critical("CVE-2", { severityLevel: "medium" })] }),
            event("container.appeared", {}),
        ]);
        expect(batch.items).toEqual([]);
        expect(batch.eventIds).toEqual([]);
    });
});

describe("shouldSendNow — the debounce", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const min = (n: number) => new Date(now.getTime() - n * 60_000);
    const opts = { now, quietMs: 10 * 60_000, maxDelayMs: 60 * 60_000 };

    it("sends once the burst has been quiet for the quiet period", () => {
        expect(shouldSendNow({ ...opts, newestAt: min(11), oldestPendingAt: min(25) })).toBe(true);
        expect(shouldSendNow({ ...opts, newestAt: min(3), oldestPendingAt: min(25) })).toBe(false);
    });

    it("stops waiting once the oldest pending event has waited the maximum", () => {
        expect(shouldSendNow({ ...opts, newestAt: min(1), oldestPendingAt: min(61) })).toBe(true);
    });

    it("has nothing to send without a pending event", () => {
        expect(shouldSendNow({ ...opts, newestAt: min(1), oldestPendingAt: null })).toBe(false);
    });
});
