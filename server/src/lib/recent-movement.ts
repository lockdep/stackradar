import type { ActivityEvent } from "../db/schema/remediation.js";
import type { LensBreakdown, SeverityBreakdown } from "../db/finding-delta.js";
import { singleBucketLens, type LensBucket, type TierCounts, type TierLens } from "../db/finding-tier.js";

/**
 * "New on running images" — the Dashboard's answer to the one question a
 * returning reader has: did anything my pods are running pick up findings
 * lately? A pure fold over `activity_events` rows into one row per image,
 * worst first, for `GET /api/feed/movement`.
 *
 * Two event types carry findings arriving on a running image:
 *
 * - `scan.findings-changed` with cause `mirror` or `upload` — the advisory
 *   database changed under an image that was already running. A first scan
 *   is excluded: its findings are inventory, not change (the move that
 *   brought the image carries the delta, below).
 * - `container.image-changed` with a measured `delta` — a tag move whose new
 *   digest carries findings the old one did not. The event's `imageId` is
 *   the *to* side, so the row is the image now running.
 *
 * Counts are exact where the payload carries exact counts
 * (`addedBySeverity`, `delta.introducedBySeverity`); the KEV advisory ids
 * come from the payload's head list, exact up to a hundred findings per
 * scan event, and a move contributes its `introducedKev` total without ids.
 * Resolved findings are folded into one total for the block's footer — the
 * block is about what arrived, and "12 also left" is one line of context.
 *
 * Scored findings only, as on the Feed page: an unscored advisory arriving
 * is not a change worth a row, and a full advisory re-sync brings hundreds
 * of them at once. The per-band breakdown still carries the `unscored`
 * count for a reader who wants it; the row's existence, count and order
 * come from the four bands.
 *
 * **Tier lens.** Events written since the component tier plan carry their
 * arrivals counted under each lens (`addedByLens`, `delta.introducedByLens`),
 * the exploited override already applied, so `?tier=` is answered from the
 * payload like every other count here. An older event has no such counts and
 * is counted whole under any lens: a lens decides what is shown first, and
 * "we cannot tell" must not read as "nothing arrived".
 */

export const EMPTY_BREAKDOWN: SeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unscored: 0 };

const BANDS = ["critical", "high", "medium", "low", "unscored"] as const satisfies readonly (keyof SeverityBreakdown)[];

type FindingHead = {
    vulnId: string;
    severityLevel: string | null;
    kevListed?: boolean;
    /** Absent on events older than the tier lens. */
    bucket?: LensBucket;
    exploited?: boolean;
};
type Slot = { namespace?: string | null; workloadKind?: string | null; workloadName?: string | null };
type MoveSide = { imageId?: string; digest?: string | null; tag?: string | null; ref?: string | null } | null;
type MoveDelta = {
    introducedKev?: number;
    introducedBySeverity?: SeverityBreakdown;
    introducedByLens?: LensBreakdown;
    resolvedBySeverity?: SeverityBreakdown;
} | null;

export interface MovementImage {
    imageId: string;
    clusterId: string | null;
    /** As the events named it; the repository fills gaps from the images table. */
    repository: string | null;
    digest: string | null;
    /** From a move's `to` side when the image arrived by one; otherwise null until the repository looks it up. */
    tag: string | null;
    /** Findings that arrived in the window, by band. */
    added: SeverityBreakdown;
    /** Scored arrivals — the four bands, not `unscored`. */
    addedCount: number;
    /** Arrivals on CISA KEV: distinct ids from scan events plus move totals. */
    kev: number;
    kevVulnIds: string[];
    resolvedCount: number;
    /** Distinct container slots (namespace/workload/container) the events named as running the image. */
    containers: number;
    scans: number;
    moves: number;
    firstAt: Date;
    lastAt: Date;
}

export interface MovementSummary {
    since: Date;
    until: Date;
    /** Worst first: KEV, then band and how many arrived in it; the newest arrival breaks a tie. */
    images: MovementImage[];
    /** Every scored finding that left in the window, across every image and move. */
    resolved: { count: number; bySeverity: SeverityBreakdown };
    /**
     * Scored arrivals under each lens, whatever lens was asked for — the
     * control's counts. Unlike the findings lists', `application` and `base`
     * here include the exploited rows each lens keeps: the payloads store the
     * counts that way, and the segment then says what clicking it will show.
     */
    tierCounts: TierCounts;
}

function bucket(level: string | null | undefined): keyof SeverityBreakdown {
    const l = (level ?? "").toLowerCase();
    return (BANDS as readonly string[]).includes(l) ? (l as keyof SeverityBreakdown) : "unscored";
}

function countHead(findings: FindingHead[]): SeverityBreakdown {
    const out = { ...EMPTY_BREAKDOWN };
    for (const f of findings) out[bucket(f.severityLevel)] += 1;
    return out;
}

function addInto(target: SeverityBreakdown, more: SeverityBreakdown | undefined | null) {
    if (!more) return;
    for (const k of BANDS) target[k] += more[k] ?? 0;
}

const SCORED = ["critical", "high", "medium", "low"] as const satisfies readonly (keyof SeverityBreakdown)[];

function scored(b: SeverityBreakdown): number {
    return SCORED.reduce((n, k) => n + b[k], 0);
}

function worstRank(b: SeverityBreakdown): number {
    const i = SCORED.findIndex((band) => b[band] > 0);
    return i < 0 ? SCORED.length : i;
}

function slotKey(s: Slot): string {
    return `${s.namespace ?? ""}/${(s.workloadKind ?? "").toLowerCase()}/${s.workloadName ?? ""}`;
}

type Accumulator = MovementImage & { slots: Set<string>; kevIds: Set<string>; slotCountFloor: number };

export function foldMovement(events: ActivityEvent[], since: Date, until: Date, lens?: TierLens): MovementSummary {
    const lensKey = singleBucketLens(lens);
    const tierCounts: TierCounts = { application: 0, base: 0, all: 0 };
    const tally = (all: SeverityBreakdown, byLens: LensBreakdown | undefined): SeverityBreakdown => {
        tierCounts.all += scored(all);
        tierCounts.application += scored(byLens?.application ?? all);
        tierCounts.base += scored(byLens?.base ?? all);
        return lensKey ? (byLens?.[lensKey] ?? all) : all;
    };
    const byImage = new Map<string, Accumulator>();
    const resolved = { count: 0, bySeverity: { ...EMPTY_BREAKDOWN } };
    /* Images whose newest scan in the window found nothing running them: a
       digest that was running earlier in the week and is gone now is not "a
       running image", however many findings it gained before it left. Walked
       newest first so the verdict is in before any older event is counted. */
    const gone = new Set<string>();
    const ordered = [...events].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const row = (event: ActivityEvent): Accumulator => {
        const id = event.imageId!;
        let acc = byImage.get(id);
        if (!acc) {
            acc = {
                imageId: id,
                clusterId: event.clusterId,
                repository: null,
                digest: null,
                tag: null,
                added: { ...EMPTY_BREAKDOWN },
                addedCount: 0,
                kev: 0,
                kevVulnIds: [],
                resolvedCount: 0,
                containers: 0,
                scans: 0,
                moves: 0,
                firstAt: event.createdAt,
                lastAt: event.createdAt,
                slots: new Set(),
                kevIds: new Set(),
                slotCountFloor: 0,
            };
            byImage.set(id, acc);
        }
        if (event.createdAt < acc.firstAt) acc.firstAt = event.createdAt;
        if (event.createdAt > acc.lastAt) acc.lastAt = event.createdAt;
        if (!acc.clusterId && event.clusterId) acc.clusterId = event.clusterId;
        return acc;
    };

    for (const event of ordered) {
        const p = event.payload as Record<string, unknown>;
        if (event.imageId && gone.has(event.imageId)) continue;
        switch (event.type) {
            case "scan.findings-changed": {
                if (p["cause"] === "first-scan") break;
                /* The scan payload counts the slots running the image at the
                   time. Zero is a digest nothing runs any more; absent is an
                   event from before the payload carried it, and is kept. */
                if (p["containerCount"] === 0) {
                    if (event.imageId && !byImage.has(event.imageId)) gone.add(event.imageId);
                    break;
                }
                const added = (p["added"] as FindingHead[] | undefined) ?? [];
                const removed = (p["removed"] as FindingHead[] | undefined) ?? [];
                const removedBy = (p["removedBySeverity"] as SeverityBreakdown | undefined) ?? countHead(removed);
                addInto(resolved.bySeverity, removedBy);
                const addedBy = tally(
                    (p["addedBySeverity"] as SeverityBreakdown | undefined) ?? countHead(added),
                    p["addedByLens"] as LensBreakdown | undefined
                );
                if (!event.imageId || scored(addedBy) === 0) {
                    /* A scan that only removed findings is footer context, not a row. */
                    break;
                }
                const acc = row(event);
                acc.scans += 1;
                addInto(acc.added, addedBy);
                acc.resolvedCount += scored(removedBy);
                for (const f of added) if (f.kevListed) acc.kevIds.add(f.vulnId);
                acc.repository ??= (p["repository"] as string | null | undefined) ?? null;
                acc.digest ??= (p["digest"] as string | null | undefined) ?? null;
                const containers = (p["containers"] as Slot[] | undefined) ?? [];
                for (const c of containers) acc.slots.add(slotKey(c));
                const containerCount = p["containerCount"];
                if (typeof containerCount === "number") acc.slotCountFloor = Math.max(acc.slotCountFloor, containerCount);
                break;
            }
            case "container.image-changed": {
                /* A move's delta has carried per-band counts since the feed
                   existed; one without them (or unmeasured, `delta: null`)
                   says nothing this block can count. */
                const delta = p["delta"] as MoveDelta | undefined;
                if (!delta?.introducedBySeverity) break;
                const resolvedBy = delta.resolvedBySeverity ?? EMPTY_BREAKDOWN;
                addInto(resolved.bySeverity, resolvedBy);
                const introducedBy = tally(delta.introducedBySeverity, delta.introducedByLens);
                if (!event.imageId || scored(introducedBy) === 0) break;
                const acc = row(event);
                acc.moves += 1;
                addInto(acc.added, introducedBy);
                acc.resolvedCount += scored(resolvedBy);
                acc.kev += delta.introducedKev ?? 0;
                const to = p["to"] as MoveSide | undefined;
                acc.repository ??= (p["repository"] as string | null | undefined) ?? null;
                acc.digest ??= to?.digest ?? null;
                acc.tag ??= to?.tag ?? null;
                acc.slots.add(slotKey(p as Slot));
                break;
            }
            default:
                break;
        }
    }

    resolved.count = scored(resolved.bySeverity);

    const images = [...byImage.values()].map(({ slots, kevIds, slotCountFloor, ...acc }) => ({
        ...acc,
        addedCount: scored(acc.added),
        kev: acc.kev + kevIds.size,
        kevVulnIds: [...kevIds],
        containers: Math.max(slots.size, slotCountFloor),
    }));
    /* Worst first: exploited arrivals, then the worst band, then how many
       landed in it and the band below. The window is already "what just
       happened" and the client marks the last day's rows, so recency only
       breaks a tie — newest first put an image that gained two criticals
       under two that gained one high, and past the fold of a three-row block. */
    images.sort(
        (a, b) =>
            b.kev - a.kev ||
            worstRank(a.added) - worstRank(b.added) ||
            b.added.critical - a.added.critical ||
            b.added.high - a.added.high ||
            b.lastAt.getTime() - a.lastAt.getTime() ||
            b.addedCount - a.addedCount
    );

    return { since, until, images, resolved, tierCounts };
}

/* ---------------------------------------------------------------------------
 * The expanded row — `GET /api/feed/movement/:imageId/findings`.
 * ------------------------------------------------------------------------- */

/** One finding that arrived on the image, as the scan event's head list names it. */
export interface ArrivedFinding {
    key: string;
    vulnId: string;
    packageName: string;
    packageType: string;
    packageVersion: string | null;
    severityLevel: string | null;
    riskScore: number;
    kevListed: boolean;
    fixedVersion: string | null;
    /** `scan`: the advisory database changed under the image. `move`: a new tag brought it. */
    via: "scan" | "move";
    /** Null for a line from an event older than the tier lens. */
    bucket: LensBucket | null;
    /** On KEV or EPSS ≥ 0.1 — what keeps a line under a lens its bucket is outside. */
    exploited: boolean;
}

/**
 * How long a `via: "scan"` arrival had already been in the image when the
 * advisory database caught up with it — the exposure plan's item 4. Always
 * null for `via: "move"`: that finding arrived with the tag, which the row
 * already says.
 */
export interface ArrivalExposure {
    /** ISO; start of the unbroken run of digests carrying it on the slots running this image. */
    presentSince: Date | null;
    presentSinceIsLowerBound: boolean;
    lowerBoundReason: "first-observation" | "history-unavailable" | "unscanned" | null;
    publishedAt: Date | null;
}

export interface Arrivals {
    /** From the scan events' head lists: deduplicated by finding key, the newest verdict on each key winning. */
    findings: ArrivedFinding[];
    /**
     * A scan event counted more scored arrivals than its head list carried
     * (the payload keeps the hundred highest-risk), so `findings` is not the
     * whole story and the image page is.
     */
    truncated: boolean;
    /** The *from* image of each measured move onto this image, newest first, distinct. Diffed by the caller. */
    moveFrom: string[];
    /** The image's newest scan found nothing running it — the same verdict that keeps it off the block. */
    gone: boolean;
}

type ArrivedHead = FindingHead & Partial<Omit<ArrivedFinding, "vulnId" | "severityLevel" | "kevListed" | "via">>;

function arrived(f: ArrivedHead, via: ArrivedFinding["via"]): ArrivedFinding {
    return {
        key: f.key ?? `${f.packageType ?? ""}|${f.packageName ?? ""}|${f.vulnId}`,
        vulnId: f.vulnId,
        packageName: f.packageName ?? "",
        packageType: f.packageType ?? "",
        packageVersion: f.packageVersion ?? null,
        severityLevel: f.severityLevel,
        riskScore: f.riskScore ?? 0,
        kevListed: f.kevListed ?? false,
        fixedVersion: f.fixedVersion ?? null,
        via,
        bucket: f.bucket ?? null,
        exploited: f.exploited ?? f.kevListed ?? false,
    };
}

/**
 * The tier lens over an unfolded row's findings. A line with no bucket (an
 * event older than the lens) passes unmarked, for the reason the module
 * header gives.
 */
export function lensArrivals(
    findings: ArrivedFinding[],
    lens: TierLens | undefined
): { findings: (ArrivedFinding & { shownDespiteTier: boolean })[]; tierCounts: TierCounts } {
    const tierCounts: TierCounts = { application: 0, base: 0, all: findings.length };
    const kept: (ArrivedFinding & { shownDespiteTier: boolean })[] = [];
    for (const f of findings) {
        if (f.bucket === "application") tierCounts.application += 1;
        else if (f.bucket === "base") tierCounts.base += 1;
        const inLens = !lens || f.bucket === null || lens.includes(f.bucket);
        if (inLens) kept.push({ ...f, shownDespiteTier: false });
        else if (f.exploited) kept.push({ ...f, shownDespiteTier: true });
    }
    return { findings: kept, tierCounts };
}

/**
 * Which findings arrived on one image in the window — the list behind a
 * movement row, where the row itself only has counts. The same events and
 * the same exclusions as {@link foldMovement}, walked newest first so that a
 * finding the advisory database added on Monday and withdrew on Thursday is
 * not listed as having arrived: the newest event naming a key decides it.
 *
 * Scan events carry their findings; a move carries only counts, so its
 * *from* image is handed back for the caller to diff against the current
 * findings (`diffFindings`), which is the same measurement the move was
 * written with, made again now.
 */
export function collectArrivals(events: ActivityEvent[], imageId: string): Arrivals {
    const ordered = events
        .filter((e) => e.imageId === imageId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const decided = new Set<string>();
    const findings: ArrivedFinding[] = [];
    const moveFrom: string[] = [];
    let truncated = false;
    let counted = false;

    for (const event of ordered) {
        const p = event.payload as Record<string, unknown>;
        switch (event.type) {
            case "scan.findings-changed": {
                if (p["cause"] === "first-scan") break;
                if (p["containerCount"] === 0) {
                    if (!counted) return { findings: [], truncated: false, moveFrom: [], gone: true };
                    break;
                }
                const added = (p["added"] as ArrivedHead[] | undefined) ?? [];
                const removed = (p["removed"] as ArrivedHead[] | undefined) ?? [];
                const addedBy = (p["addedBySeverity"] as SeverityBreakdown | undefined) ?? countHead(added);
                if (scored(addedBy) === 0) break;
                counted = true;
                if (scored(addedBy) > added.filter((f) => bucket(f.severityLevel) !== "unscored").length) truncated = true;
                for (const f of added) {
                    const key = arrived(f, "scan").key;
                    if (decided.has(key)) continue;
                    decided.add(key);
                    if (bucket(f.severityLevel) !== "unscored") findings.push(arrived(f, "scan"));
                }
                for (const f of removed) decided.add(arrived(f, "scan").key);
                break;
            }
            case "container.image-changed": {
                const delta = p["delta"] as MoveDelta | undefined;
                if (!delta?.introducedBySeverity || scored(delta.introducedBySeverity) === 0) break;
                counted = true;
                const from = (p["from"] as MoveSide | undefined)?.imageId;
                if (from && !moveFrom.includes(from)) moveFrom.push(from);
                break;
            }
            default:
                break;
        }
    }

    return { findings, truncated, moveFrom, gone: false };
}

/** Worst first: band, then KEV, then risk — the order a reader scanning a list expects. */
export function byArrivalOrder(a: ArrivedFinding, b: ArrivedFinding): number {
    const band = worstRank({ ...EMPTY_BREAKDOWN, [bucket(a.severityLevel)]: 1 }) - worstRank({ ...EMPTY_BREAKDOWN, [bucket(b.severityLevel)]: 1 });
    if (band !== 0) return band;
    if (a.kevListed !== b.kevListed) return a.kevListed ? -1 : 1;
    return b.riskScore - a.riskScore;
}
