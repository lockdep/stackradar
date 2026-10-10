import { describe, it, expect } from "vitest";
import {
    CONTIGUITY_TOLERANCE_MS,
    earliestPresence,
    exposureOf,
    presenceOnSlot,
    remediationWindows,
    type ImageFindingKeys,
    type SlotHistoryInput,
    type SlotInterval,
} from "../../../src/lib/exposure.js";

const KEY = "library|openssl|CVE-2026-0001";
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

/** The cluster was first observed on day 0 unless a test says otherwise. */
const OBSERVED = day(0);

function interval(digest: string, from: number, to: number | null, imageId: string | null = `img-${digest}`): SlotInterval {
    return { digest, imageId, startedAt: day(from), endedAt: to === null ? null : day(to) };
}

function findings(entries: Record<string, string[] | "unscanned">): ImageFindingKeys {
    return new Map(Object.entries(entries).map(([id, keys]) => [id, keys === "unscanned" ? keys : new Set(keys)]));
}

function input(intervals: SlotInterval[], keys: ImageFindingKeys, extra: Partial<SlotHistoryInput> = {}): SlotHistoryInput {
    return { intervals, findings: keys, key: KEY, observationStart: OBSERVED, ...extra };
}

describe("presenceOnSlot", () => {
    it("dates a single open interval from its start, exactly, when it began after observation did", () => {
        const p = presenceOnSlot(input([interval("a", 10, null)], findings({ "img-a": [KEY] })));
        expect(p).toEqual({ presentSince: day(10), presentSinceIsLowerBound: false, lowerBoundReason: null });
    });

    it("is null when no running digest carries the finding", () => {
        expect(presenceOnSlot(input([interval("a", 10, null)], findings({ "img-a": [] })))).toBeNull();
        expect(presenceOnSlot(input([interval("a", 10, 20)], findings({ "img-a": [KEY] })))).toBeNull();
    });

    it("keeps the clock running across a rollout when both digests carry it", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, 40)],
            findings({ "img-a": [KEY], "img-b": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(10), presentSinceIsLowerBound: false, lowerBoundReason: null });
    });

    it("walks more than one digest back", () => {
        const p = presenceOnSlot(input(
            [interval("c", 60, null), interval("b", 40, 60), interval("a", 10, 40), interval("z", 5, 10)],
            findings({ "img-a": [KEY], "img-b": [KEY], "img-c": [KEY], "img-z": [] })
        ));
        expect(p?.presentSince).toEqual(day(10));
        expect(p?.presentSinceIsLowerBound).toBe(false);
    });

    it("stops exactly at B's start when A was scanned and clean", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, 40)],
            findings({ "img-a": ["library|zlib|CVE-2026-0002"], "img-b": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(40), presentSinceIsLowerBound: false, lowerBoundReason: null });
    });

    it("is a lower bound when the previous image was collected", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, 40, null)],
            findings({ "img-b": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(40), presentSinceIsLowerBound: true, lowerBoundReason: "history-unavailable" });
    });

    it("is a lower bound when the previous image was never scanned", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, 40)],
            findings({ "img-a": "unscanned", "img-b": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(40), presentSinceIsLowerBound: true, lowerBoundReason: "unscanned" });
    });

    it("is a lower bound when the slot was in the cluster's first report", () => {
        const p = presenceOnSlot(input([interval("a", 0, null)], findings({ "img-a": [KEY] })));
        expect(p).toEqual({ presentSince: day(0), presentSinceIsLowerBound: true, lowerBoundReason: "first-observation" });
    });

    it("is a lower bound when the walk reaches the first report", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 0, 40)],
            findings({ "img-a": [KEY], "img-b": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(0), presentSinceIsLowerBound: true, lowerBoundReason: "first-observation" });
    });

    it("proves nothing when the cluster's first observation is unknown", () => {
        const p = presenceOnSlot(input([interval("a", 10, null)], findings({ "img-a": [KEY] }), { observationStart: null }));
        expect(p?.presentSinceIsLowerBound).toBe(true);
    });

    it("stops exactly at a gap: the slot was gone, then came back", () => {
        const p = presenceOnSlot(input(
            [interval("a", 40, null), interval("a", 10, 30)],
            findings({ "img-a": [KEY] })
        ));
        expect(p).toEqual({ presentSince: day(40), presentSinceIsLowerBound: false, lowerBoundReason: null });
    });

    it("treats a start within one cadence of the previous end as contiguous", () => {
        const almost = new Date(day(40).getTime() - CONTIGUITY_TOLERANCE_MS);
        const p = presenceOnSlot(input(
            [interval("b", 40, null), { digest: "a", imageId: "img-a", startedAt: day(10), endedAt: almost }],
            findings({ "img-a": [KEY], "img-b": [KEY] })
        ));
        expect(p?.presentSince).toEqual(day(10));
    });

    it("takes the earliest carrying open interval mid-rollout", () => {
        const both = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, null)],
            findings({ "img-a": [KEY], "img-b": [KEY] })
        ));
        expect(both?.presentSince).toEqual(day(10));

        // Only the digest being rolled *to* carries it: the old one, still
        // serving and clean, is what ran before — exact.
        const newOnly = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, null)],
            findings({ "img-a": [], "img-b": [KEY] })
        ));
        expect(newOnly).toEqual({ presentSince: day(40), presentSinceIsLowerBound: false, lowerBoundReason: null });
    });

    it("is a lower bound when nothing is in front and the start predates the retention cutoff", () => {
        const p = presenceOnSlot(input([interval("a", 10, null)], findings({ "img-a": [KEY] }), { retentionCutoff: day(20) }));
        expect(p).toEqual({ presentSince: day(10), presentSinceIsLowerBound: true, lowerBoundReason: "history-unavailable" });
    });

    it("is a lower bound when the history read was capped", () => {
        const p = presenceOnSlot(input(
            [interval("b", 40, null), interval("a", 10, 40)],
            findings({ "img-a": [KEY], "img-b": [KEY] }),
            { truncated: true }
        ));
        expect(p).toEqual({ presentSince: day(10), presentSinceIsLowerBound: true, lowerBoundReason: "history-unavailable" });
    });

    describe("rule 5: the workload's earliest pod start", () => {
        it("refines a single open interval, and stays a lower bound", () => {
            const p = presenceOnSlot(input([interval("a", 0, null)], findings({ "img-a": [KEY] }), { workloadFirstStartedAt: day(-100) }));
            expect(p).toEqual({ presentSince: day(-100), presentSinceIsLowerBound: true, lowerBoundReason: "first-observation" });
        });

        it("is off mid-rollout: the earliest pod may be on the other digest", () => {
            const p = presenceOnSlot(input(
                [interval("b", 0, null), interval("a", 0, null)],
                findings({ "img-a": [], "img-b": [KEY] }),
                { workloadFirstStartedAt: day(-100) }
            ));
            expect(p?.presentSince).toEqual(day(0));
        });

        it("is off when the chain was stitched from several intervals", () => {
            const p = presenceOnSlot(input(
                [interval("b", 40, null), interval("a", 0, 40)],
                findings({ "img-a": [KEY], "img-b": [KEY] }),
                { workloadFirstStartedAt: day(-100) }
            ));
            expect(p?.presentSince).toEqual(day(0));
        });

        it("is off when a clean digest demonstrably ran before: a pod patched in place keeps its start time", () => {
            const p = presenceOnSlot(input(
                [interval("b", 40, null), interval("a", 10, 40)],
                findings({ "img-a": [], "img-b": [KEY] }),
                { workloadFirstStartedAt: day(-100) }
            ));
            expect(p).toEqual({ presentSince: day(40), presentSinceIsLowerBound: false, lowerBoundReason: null });
        });

        it("ignores a pod start that is not earlier", () => {
            const p = presenceOnSlot(input([interval("a", 10, null)], findings({ "img-a": [KEY] }), { workloadFirstStartedAt: day(12) }));
            expect(p).toEqual({ presentSince: day(10), presentSinceIsLowerBound: false, lowerBoundReason: null });
        });
    });
});

describe("exposureOf", () => {
    const lowerBound = { presentSince: day(0), presentSinceIsLowerBound: true, lowerBoundReason: "first-observation" as const };
    const exact = { presentSince: day(40), presentSinceIsLowerBound: false, lowerBoundReason: null };

    it("is exact when the CVE was published after a lower-bound presence", () => {
        const e = exposureOf(lowerBound, day(28), null);
        expect(e.exposedSince).toEqual(day(28));
        expect(e.exposedSinceIsLowerBound).toBe(false);
        expect(e.presentSinceIsLowerBound).toBe(true);
    });

    it("carries the lower bound when presence wins the max", () => {
        const e = exposureOf(lowerBound, day(-300), null);
        expect(e.exposedSince).toEqual(day(0));
        expect(e.exposedSinceIsLowerBound).toBe(true);
    });

    it("has no exposure figure when publishedAt is null, and says so with null", () => {
        const e = exposureOf(exact, null, null);
        expect(e.exposedSince).toBeNull();
        expect(e.exposedSinceIsLowerBound).toBe(false);
        expect(e.presentSince).toEqual(day(40));
    });

    it("dates exploitation from the KEV listing when that came after presence", () => {
        const e = exposureOf(lowerBound, day(-300), day(21));
        expect(e.exploitedSince).toEqual(day(21));
        expect(e.exploitedSinceIsLowerBound).toBe(false);
    });

    it("dates exploitation from presence when the KEV listing is older", () => {
        const e = exposureOf(lowerBound, day(-300), day(-50));
        expect(e.exploitedSince).toEqual(day(0));
        expect(e.exploitedSinceIsLowerBound).toBe(true);
    });

    it("is null off KEV", () => {
        expect(exposureOf(exact, day(1), null).exploitedSince).toBeNull();
    });
});

describe("earliestPresence", () => {
    it("takes the earliest, and the flag follows the winner", () => {
        const a = { presentSince: day(5), presentSinceIsLowerBound: true, lowerBoundReason: "unscanned" as const };
        const b = { presentSince: day(9), presentSinceIsLowerBound: false, lowerBoundReason: null };
        expect(earliestPresence([b, null, a])).toBe(a);
        expect(earliestPresence([])).toBeNull();
    });

    it("prefers the lower bound on a tie", () => {
        const a = { presentSince: day(5), presentSinceIsLowerBound: false, lowerBoundReason: null };
        const b = { presentSince: day(5), presentSinceIsLowerBound: true, lowerBoundReason: "first-observation" as const };
        expect(earliestPresence([a, b])).toBe(b);
    });
});

describe("remediationWindows", () => {
    it("closes a window when the next digest is scanned and clean", () => {
        const [w, ...rest] = remediationWindows({
            ...input(
                [interval("c", 46, null), interval("b", 40, 46), interval("a", 10, 40)],
                findings({ "img-a": [KEY], "img-b": [KEY], "img-c": [] })
            ),
            publishedAt: day(38),
        });
        expect(rest).toEqual([]);
        expect(w?.presentSince).toEqual(day(10));
        expect(w?.remediatedAt).toEqual(day(46));
        expect(w?.timeToRemediateMs).toBe(8 * 86_400_000);
        expect(w?.timeToRemediateIsLowerBound).toBe(false);
    });

    it("measures from presence, as a lower bound, when that is what won", () => {
        const [w] = remediationWindows({
            ...input(
                [interval("b", 30, null), interval("a", 0, 30)],
                findings({ "img-a": [KEY], "img-b": [] })
            ),
            publishedAt: day(-200),
        });
        expect(w?.timeToRemediateMs).toBe(30 * 86_400_000);
        expect(w?.timeToRemediateIsLowerBound).toBe(true);
    });

    it("falls back to presence when publishedAt is null", () => {
        const [w] = remediationWindows({
            ...input([interval("b", 30, null), interval("a", 10, 30)], findings({ "img-a": [KEY], "img-b": [] })),
            publishedAt: null,
        });
        expect(w?.timeToRemediateMs).toBe(20 * 86_400_000);
    });

    it("does not call a removed slot remediated", () => {
        expect(remediationWindows({
            ...input([interval("a", 10, 30)], findings({ "img-a": [KEY] })),
            publishedAt: day(1),
        })).toEqual([]);
    });

    it("does not count a successor it cannot read", () => {
        expect(remediationWindows({
            ...input([interval("b", 30, null), interval("a", 10, 30)], findings({ "img-a": [KEY], "img-b": "unscanned" })),
            publishedAt: day(1),
        })).toEqual([]);
    });

    it("skips a run that is still open", () => {
        expect(remediationWindows({
            ...input([interval("a", 10, null)], findings({ "img-a": [KEY] })),
            publishedAt: day(1),
        })).toEqual([]);
    });
});
