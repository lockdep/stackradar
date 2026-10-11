/**
 * How long a finding has been running.
 *
 * The product says *what* a vulnerability affects; this module says *for how
 * long it has*. A **slot** (`container-slots.ts`) is the thing with identity
 * across digests, and `workload_container_history` records which digest it ran
 * from one inventory report until another. A finding's presence on a slot is
 * the unbroken run of those intervals whose digests all carry it: a rollout
 * from digest A to digest B that both contain the vulnerable package does
 * **not** reset the clock.
 *
 * Pure: the caller reads the slot's intervals and the finding keys of the
 * images on them and feeds both in here, so every stop rule is a case a unit
 * test can spell out without a database.
 *
 * Two disciplines, both from the repo's "none is never unknown" rule:
 *
 * - A start we could not observe is a **lower bound** on the duration and is
 *   carried as one, with the reason. It is never rendered as an exact figure.
 * - The lower-bound flag is **per derived field**. A CVE published two days
 *   ago on a container watched for "≥ 30 d" has an *exact* exposure of two
 *   days: the flag follows `presentSince` only when `presentSince` wins the
 *   `max`.
 *
 * Exposure never enters the risk score (ADR 0005, ADR 0007). Everything here
 * is a displayed fact and, at most, a sort key.
 */

/**
 * How far apart one interval's end and the next one's start may be and still
 * count as the same unbroken run. Intervals close and open in the same
 * inventory report, so they normally match exactly; the slack is one
 * inventory cadence, for a slot whose replacement landed a report later.
 */
export const CONTIGUITY_TOLERANCE_MS = 10 * 60 * 1000;

/** One row of `workload_container_history`, as far as this module cares. */
export interface SlotInterval {
    digest: string;
    /** `null` = the image was garbage-collected: we know what ran, not what was in it. */
    imageId: string | null;
    startedAt: Date;
    /** `null` = still running. */
    endedAt: Date | null;
}

/**
 * The finding keys (`ComparableFinding.key`) each walked image carries.
 * `"unscanned"` = the image exists but has no successful scan, so its empty
 * finding set proves nothing. An image id absent from the map is treated the
 * same as a collected one.
 */
export type ImageFindingKeys = ReadonlyMap<string, ReadonlySet<string> | "unscanned">;

/**
 * Why a start is a lower bound, in the words the UI needs:
 *
 * - `first-observation` — it was already running when we first looked at the
 *   cluster (or the pods predate the interval we recorded).
 * - `history-unavailable` — the image that ran before is gone (image GC), or
 *   the rows before it are outside the plan's history window, or the walk hit
 *   its cap.
 * - `unscanned` — the image that ran before was never successfully scanned.
 */
export type LowerBoundReason = "first-observation" | "history-unavailable" | "unscanned";

export interface Presence {
    presentSince: Date;
    presentSinceIsLowerBound: boolean;
    /** Null exactly when `presentSinceIsLowerBound` is false. */
    lowerBoundReason: LowerBoundReason | null;
}

export interface SlotHistoryInput {
    /** The slot's intervals, any order. */
    intervals: readonly SlotInterval[];
    findings: ImageFindingKeys;
    /** The `ComparableFinding.key` being asked about. */
    key: string;
    /** When this cluster's inventory was first observed; null = unknown, which proves nothing. */
    observationStart: Date | null;
    /**
     * Closed intervals that ended before this were swept by retention, so a
     * run that starts before it with nothing in front cannot prove it was
     * the first.
     */
    retentionCutoff?: Date | null;
    /** `workloads.first_started_at` — rule 5's refinement. */
    workloadFirstStartedAt?: Date | null;
    /** The history read hit its per-slot cap, so older rows may exist unseen. */
    truncated?: boolean;
}

/** A point in time plus whether the true value may be earlier. */
export interface Since {
    since: Date;
    isLowerBound: boolean;
}

export interface Exposure extends Presence {
    /** `max(presentSince, publishedAt)`; null when `publishedAt` is. */
    exposedSince: Date | null;
    exposedSinceIsLowerBound: boolean;
    /** `max(presentSince, kevListedAt)`; null off KEV. */
    exploitedSince: Date | null;
    exploitedSinceIsLowerBound: boolean;
}

type Carries = "yes" | "no" | "collected" | "unscanned";

function carries(interval: SlotInterval, findings: ImageFindingKeys, key: string): Carries {
    if (!interval.imageId) return "collected";
    const keys = findings.get(interval.imageId);
    if (keys === undefined) return "collected";
    if (keys === "unscanned") return "unscanned";
    return keys.has(key) ? "yes" : "no";
}

const time = (d: Date) => d.getTime();

/** An unbroken run of intervals that all carry the finding. */
interface Run {
    start: Date;
    /** `null` = still running. */
    end: Date | null;
    intervals: number;
}

/**
 * The carrying intervals, merged into unbroken runs, newest first. Overlap
 * counts as contiguous: mid-rollout, two digests that both carry the finding
 * are one run.
 */
function carryingRuns(input: SlotHistoryInput): Run[] {
    const carrying = input.intervals
        .filter((i) => carries(i, input.findings, input.key) === "yes")
        .sort((a, b) => time(a.startedAt) - time(b.startedAt));

    const runs: Run[] = [];
    for (const interval of carrying) {
        const last = runs[runs.length - 1];
        const touches =
            last && (last.end === null || time(interval.startedAt) <= time(last.end) + CONTIGUITY_TOLERANCE_MS);
        if (last && touches) {
            if (last.end !== null && (interval.endedAt === null || time(interval.endedAt) > time(last.end))) {
                last.end = interval.endedAt;
            }
            last.intervals += 1;
        } else {
            runs.push({ start: interval.startedAt, end: interval.endedAt, intervals: 1 });
        }
    }
    return runs.reverse();
}

/**
 * Whether a run's start is when the finding really arrived on the slot, or
 * only as far back as we can see. Decided by what ran *immediately before*:
 *
 * - a scanned digest without the finding → exact (rule 3);
 * - a collected or unscanned digest → lower bound (rule 4);
 * - nothing contiguous, but older rows exist → exact: the slot was gone and
 *   came back (rule 3). Retention sweeps on `ended_at`, oldest first, so an
 *   older row surviving proves the contiguous one was never there;
 * - nothing at all → exact only when the run began after we started
 *   observing the cluster and inside what retention still holds (rule 4).
 */
function startOf(run: Run, input: SlotHistoryInput): Presence {
    const start = time(run.start);
    const exact: Presence = { presentSince: run.start, presentSinceIsLowerBound: false, lowerBoundReason: null };
    const lowerBound = (reason: LowerBoundReason, since = run.start): Presence => ({
        presentSince: since,
        presentSinceIsLowerBound: true,
        lowerBoundReason: reason,
    });

    const earlier = input.intervals.filter(
        (i) => time(i.startedAt) < start && carries(i, input.findings, input.key) !== "yes",
    );
    const before = earlier.filter((i) => i.endedAt === null || time(i.endedAt) >= start - CONTIGUITY_TOLERANCE_MS);

    if (before.length > 0) {
        const verdicts = before.map((i) => carries(i, input.findings, input.key));
        if (verdicts.includes("collected")) return lowerBound("history-unavailable");
        if (verdicts.includes("unscanned")) return lowerBound("unscanned");
        return exact;
    }

    /*
     * Rule 5. Nothing ran in front of this run that we recorded, so the
     * workload's earliest pod start is admissible evidence — but only for a
     * single open interval on a slot that is not mid-rollout, where the
     * earliest pod is on this digest. It stays a lower bound: pods restart,
     * so an earlier pod generation may have run the same digest. Not applied
     * when an interval *was* recorded in front: a container patched in place
     * keeps its pod's start time across the digest change.
     */
    const openIntervals = input.intervals.filter((i) => i.endedAt === null).length;
    const podStart = input.workloadFirstStartedAt ?? null;
    if (run.end === null && run.intervals === 1 && openIntervals === 1 && podStart && time(podStart) < start) {
        return lowerBound("first-observation", podStart);
    }

    if (earlier.length > 0) return exact;
    if (input.truncated) return lowerBound("history-unavailable");
    if (!input.observationStart || start <= time(input.observationStart) + CONTIGUITY_TOLERANCE_MS) {
        return lowerBound("first-observation");
    }
    if (input.retentionCutoff && start < time(input.retentionCutoff)) return lowerBound("history-unavailable");
    return exact;
}

/**
 * Since when the finding has been on this slot without a break, or null when
 * no running digest of the slot carries it.
 */
export function presenceOnSlot(input: SlotHistoryInput): Presence | null {
    const running = carryingRuns(input).find((run) => run.end === null);
    return running ? startOf(running, input) : null;
}

/**
 * `max(presence, anchor)` with its own lower-bound flag: the flag survives
 * only when the presence side wins. Equal counts as the anchor winning — a
 * lower-bound presence can only be *earlier*, and then the anchor is the max.
 */
export function sinceAnchor(
    presence: Pick<Presence, "presentSince" | "presentSinceIsLowerBound">,
    anchor: Date | null,
): Since | null {
    if (!anchor) return null;
    return time(presence.presentSince) > time(anchor)
        ? { since: presence.presentSince, isLowerBound: presence.presentSinceIsLowerBound }
        : { since: anchor, isLowerBound: false };
}

/** A presence plus the two anchored figures — the vocabulary of the plan, in one value. */
export function exposureOf(presence: Presence, publishedAt: Date | null, kevListedAt: Date | null): Exposure {
    const exposed = sinceAnchor(presence, publishedAt);
    const exploited = sinceAnchor(presence, kevListedAt);
    return {
        ...presence,
        exposedSince: exposed?.since ?? null,
        exposedSinceIsLowerBound: exposed?.isLowerBound ?? false,
        exploitedSince: exploited?.since ?? null,
        exploitedSinceIsLowerBound: exploited?.isLowerBound ?? false,
    };
}

/**
 * Fold several presences (a vulnerability's keys on one slot, a workload's
 * slots) into one: the earliest wins and the flag follows the winner. On a
 * tie the lower bound wins, because its true start can only be earlier.
 */
export function earliestPresence(presences: readonly (Presence | null | undefined)[]): Presence | null {
    let winner: Presence | null = null;
    for (const p of presences) {
        if (!p) continue;
        if (
            !winner ||
            time(p.presentSince) < time(winner.presentSince) ||
            (time(p.presentSince) === time(winner.presentSince) &&
                p.presentSinceIsLowerBound &&
                !winner.presentSinceIsLowerBound)
        ) {
            winner = p;
        }
    }
    return winner;
}

/** The earliest of several anchored figures; same tie rule as {@link earliestPresence}. */
export function earliestSince(values: readonly (Since | null | undefined)[]): Since | null {
    let winner: Since | null = null;
    for (const v of values) {
        if (!v) continue;
        if (
            !winner ||
            time(v.since) < time(winner.since) ||
            (time(v.since) === time(winner.since) && v.isLowerBound && !winner.isLowerBound)
        ) {
            winner = v;
        }
    }
    return winner;
}

/**
 * A closed exposure window: the finding ran on the slot, and the digest that
 * replaced it demonstrably does not carry it.
 */
export interface RemediationWindow extends Presence {
    remediatedAt: Date;
    /** `remediatedAt − max(presentSince, publishedAt)`; from `presentSince` alone when `publishedAt` is null. Never negative. */
    timeToRemediateMs: number;
    /** True when the window's start is a lower bound and wins the `max`: the real figure is at least this. */
    timeToRemediateIsLowerBound: boolean;
}

/**
 * The slot's *closed* runs that ended in a fix. A run counts only when the
 * slot kept running and what replaced it is scanned and clean: a slot that
 * simply went away was removed, not remediated, and a successor we cannot
 * read (collected, unscanned) proves nothing either way. Newest first.
 */
export function remediationWindows(input: SlotHistoryInput & { publishedAt: Date | null }): RemediationWindow[] {
    const windows: RemediationWindow[] = [];
    for (const run of carryingRuns(input)) {
        if (run.end === null) continue;
        const end = time(run.end);
        const successors = input.intervals.filter(
            (i) =>
                carries(i, input.findings, input.key) !== "yes" &&
                time(i.startedAt) <= end + CONTIGUITY_TOLERANCE_MS &&
                (i.endedAt === null || time(i.endedAt) > end),
        );
        if (successors.length === 0) continue;
        if (successors.some((i) => carries(i, input.findings, input.key) !== "no")) continue;

        const presence = startOf(run, input);
        const from = sinceAnchor(presence, input.publishedAt) ?? {
            since: presence.presentSince,
            isLowerBound: presence.presentSinceIsLowerBound,
        };
        windows.push({
            ...presence,
            remediatedAt: run.end,
            timeToRemediateMs: Math.max(0, end - time(from.since)),
            timeToRemediateIsLowerBound: from.isLowerBound,
        });
    }
    return windows;
}
