import type { ActivityEvent } from "../db/schema/remediation.js";

/**
 * Which `activity_events` deserve an alert, and how a batch of them folds
 * into one message — the pure half of `services/alert.service.ts`
 * (strategy doc 2026-09-26 §3 P3).
 *
 * ## What qualifies
 *
 * "A new critical or KEV finding on a running image" — with the org's own
 * {@link AlertCriteria} deciding what "critical" and "KEV" mean for it:
 * the severity floor (`critical` by default, `high` for the cautious,
 * `none` for KEV-only) and whether CISA KEV counts regardless of severity.
 * Two event types say it, and nothing else does:
 *
 * - `scan.findings-changed` with cause `mirror` or `upload` — the advisory
 *   database changed against a digest that was already running, and an
 *   *added* finding is critical or on CISA KEV, or a finding already there
 *   was *rescored* into critical. A `first-scan` is inventory, not change
 *   (the digest and the Feed make the same exclusion): the image arrived
 *   that day, its findings did not. An event with `containerCount: 0` is
 *   about an image nothing runs any more and is skipped for the same
 *   reason.
 * - `finding.kev-listed` — CISA listed an advisory that was already a
 *   finding on running images (`services/kev-listing.service.ts`). Always
 *   qualifies: the listing is the whole point.
 *
 * Not `container.image-changed`. A deploy that ships a critical is the
 * team's own action and the Feed shows it on the day; the alert exists for
 * the world changing under a running image, which nobody is watching for.
 * A move's payload also carries counts and not the findings, so the message
 * could not name the CVE.
 *
 * ## The fold
 *
 * One message per pass, grouped **by advisory**: an OSV publish against
 * glibc reaches every image in the fleet within the hour, as forty events,
 * and forty emails saying the same CVE is the failure mode a notification
 * feature dies of. Each advisory lists the images it landed on (worst first,
 * capped) and the reason it qualified. Order is exploited first, then by
 * risk contribution — the same rule as every list in the product.
 */

export type AlertReason = "kev-listed" | "new-kev" | "new-critical" | "rescored-critical";

/** The org's choice of what is worth a message — `organizations.alert_min_severity` / `alert_kev`. */
export interface AlertCriteria {
    /** Findings at or above this severity alert; `none` switches the severity rule off. */
    minSeverity: "critical" | "high" | "none";
    /** Anything on CISA KEV alerts, whatever its severity. */
    kev: boolean;
}

export const DEFAULT_ALERT_CRITERIA: AlertCriteria = { minSeverity: "critical", kev: true };

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Whether `level` is at or above the criteria's floor. `none` admits nothing. */
export function meetsSeverity(level: string | null | undefined, criteria: AlertCriteria): boolean {
    if (criteria.minSeverity === "none") return false;
    return (SEVERITY_RANK[(level ?? "").toLowerCase()] ?? 0) >= SEVERITY_RANK[criteria.minSeverity]!;
}

export interface AlertImage {
    imageId: string | null;
    repository: string | null;
    digest: string | null;
    clusterId: string | null;
    /** Containers running the image, from the event; null when the event did not say. */
    containerCount: number | null;
    /** `namespace/workload` labels, the head of the event's list. */
    containers: string[];
}

export interface AlertItem {
    vulnId: string;
    /** The strongest reason among the events folded into this item. */
    reason: AlertReason;
    /** `critical`, `high`, … as the advisory carries it; null when unscored. */
    severityLevel: string | null;
    kevListed: boolean;
    /** Max 0–100 contribution seen across the folded findings. */
    riskScore: number;
    /** `name@version` strings, distinct, head only. */
    packages: string[];
    fixedVersion: string | null;
    images: AlertImage[];
    /** Distinct images, exact even when `images` is capped. */
    imageCount: number;
    /** Distinct clusters touched. */
    clusterIds: string[];
    /** Events folded into this item. */
    eventIds: string[];
}

export interface AlertBatch {
    items: AlertItem[];
    /** Every event that contributed, for the send record. */
    eventIds: string[];
    /** Qualifying events that were folded, before grouping. */
    eventCount: number;
}

/** Head of an event's added/rescored list — the fields a line needs. */
interface FindingHead {
    vulnId: string;
    packageName?: string;
    packageVersion?: string | null;
    severityLevel?: string | null;
    riskScore?: number;
    kevListed?: boolean;
    fixedVersion?: string | null;
    previousSeverityLevel?: string | null;
}

interface ContainerHead {
    namespace?: string;
    workloadName?: string;
    workloadKind?: string | null;
    init?: boolean;
}

/** An image the `finding.kev-listed` payload names. */
interface KevListedImage {
    imageId: string;
    repository: string | null;
    digest: string | null;
    clusterId: string | null;
    containerCount: number;
    containers?: ContainerHead[];
}

export const IMAGES_PER_ITEM = 10;
export const PACKAGES_PER_ITEM = 5;
export const CONTAINERS_PER_IMAGE = 5;

const REASON_RANK: Record<AlertReason, number> = {
    "kev-listed": 0,
    "new-kev": 1,
    "new-critical": 2,
    "rescored-critical": 3,
};

function isCritical(level: string | null | undefined): boolean {
    return (level ?? "").toLowerCase() === "critical";
}

function containerLabels(containers: ContainerHead[] | undefined): string[] {
    return (containers ?? [])
        .filter((c) => !c.init)
        .slice(0, CONTAINERS_PER_IMAGE)
        .map((c) => `${c.namespace ?? "?"}/${c.workloadName ?? "?"}`);
}

/**
 * The reason an added or rescored finding qualifies under `criteria`, or
 * null when it does not. KEV beats severity: it is the stronger claim and
 * the one CISA puts a due date on.
 */
export function findingReason(f: FindingHead, list: "added" | "rescored", criteria: AlertCriteria = DEFAULT_ALERT_CRITERIA): AlertReason | null {
    if (list === "added") {
        if (criteria.kev && f.kevListed) return "new-kev";
        if (meetsSeverity(f.severityLevel, criteria)) return "new-critical";
        return null;
    }
    // Rescored: only a move *into* the floor is news. A KEV flag on a
    // rescored finding was already there before the rescore.
    if (meetsSeverity(f.severityLevel, criteria) && !meetsSeverity(f.previousSeverityLevel, criteria)) return "rescored-critical";
    return null;
}

/** Whether one event carries anything to alert on under `criteria`. Cheap; the fold does the rest. */
export function eventQualifies(event: ActivityEvent, criteria: AlertCriteria = DEFAULT_ALERT_CRITERIA): boolean {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
        case "finding.kev-listed":
            return criteria.kev && typeof p["vulnId"] === "string";
        case "scan.findings-changed": {
            if (p["cause"] === "first-scan") return false;
            if (p["containerCount"] === 0) return false;
            const added = (p["added"] as FindingHead[] | undefined) ?? [];
            const rescored = (p["rescored"] as FindingHead[] | undefined) ?? [];
            return (
                added.some((f) => findingReason(f, "added", criteria) != null) ||
                rescored.some((f) => findingReason(f, "rescored", criteria) != null)
            );
        }
        default:
            return false;
    }
}

interface Accumulator {
    item: AlertItem;
    images: Map<string, AlertImage>;
    packages: Set<string>;
    clusters: Set<string>;
}

function accumulatorFor(map: Map<string, Accumulator>, vulnId: string): Accumulator {
    let acc = map.get(vulnId);
    if (!acc) {
        acc = {
            item: {
                vulnId,
                reason: "rescored-critical",
                severityLevel: null,
                kevListed: false,
                riskScore: 0,
                packages: [],
                fixedVersion: null,
                images: [],
                imageCount: 0,
                clusterIds: [],
                eventIds: [],
            },
            images: new Map(),
            packages: new Set(),
            clusters: new Set(),
        };
        map.set(vulnId, acc);
    }
    return acc;
}

function noteReason(acc: Accumulator, reason: AlertReason) {
    if (REASON_RANK[reason] < REASON_RANK[acc.item.reason] || acc.item.eventIds.length === 0) acc.item.reason = reason;
}

function noteFinding(acc: Accumulator, f: FindingHead) {
    if (isCritical(f.severityLevel) || !acc.item.severityLevel) acc.item.severityLevel = f.severityLevel ?? acc.item.severityLevel;
    if (f.kevListed) acc.item.kevListed = true;
    if ((f.riskScore ?? 0) > acc.item.riskScore) acc.item.riskScore = f.riskScore ?? 0;
    if (f.packageName) acc.packages.add(f.packageVersion ? `${f.packageName}@${f.packageVersion}` : f.packageName);
    if (f.fixedVersion && !acc.item.fixedVersion) acc.item.fixedVersion = f.fixedVersion;
}

function noteImage(acc: Accumulator, image: AlertImage) {
    const key = image.imageId ?? `${image.repository ?? ""}@${image.digest ?? ""}`;
    const existing = acc.images.get(key);
    if (existing) {
        // The later event's view of the same image wins on the mutable bits.
        if (image.containerCount != null) existing.containerCount = image.containerCount;
        if (image.containers.length > 0) existing.containers = image.containers;
    } else {
        acc.images.set(key, image);
    }
    if (image.clusterId) acc.clusters.add(image.clusterId);
}

/**
 * Fold a pass's qualifying events into one batch. Events that do not qualify
 * are ignored here too, so callers can hand over the raw window.
 */
export function buildAlertBatch(events: ActivityEvent[], criteria: AlertCriteria = DEFAULT_ALERT_CRITERIA): AlertBatch {
    const byVuln = new Map<string, Accumulator>();
    const eventIds: string[] = [];
    let eventCount = 0;

    for (const event of events) {
        if (!eventQualifies(event, criteria)) continue;
        const p = event.payload as Record<string, unknown>;
        eventIds.push(event.id);
        eventCount += 1;

        if (event.type === "finding.kev-listed") {
            const acc = accumulatorFor(byVuln, p["vulnId"] as string);
            noteReason(acc, "kev-listed");
            acc.item.eventIds.push(event.id);
            acc.item.kevListed = true;
            noteFinding(acc, {
                vulnId: p["vulnId"] as string,
                severityLevel: (p["severityLevel"] as string | null | undefined) ?? null,
                riskScore: (p["riskScore"] as number | undefined) ?? 0,
                kevListed: true,
                fixedVersion: null,
            });
            for (const pkg of (p["packages"] as string[] | undefined) ?? []) acc.packages.add(pkg);
            for (const img of (p["images"] as KevListedImage[] | undefined) ?? []) {
                noteImage(acc, {
                    imageId: img.imageId,
                    repository: img.repository,
                    digest: img.digest,
                    clusterId: img.clusterId,
                    containerCount: img.containerCount,
                    containers: containerLabels(img.containers),
                });
            }
            continue;
        }

        // scan.findings-changed
        const image: AlertImage = {
            imageId: event.imageId,
            repository: (p["repository"] as string | null | undefined) ?? null,
            digest: (p["digest"] as string | null | undefined) ?? null,
            clusterId: event.clusterId,
            containerCount: typeof p["containerCount"] === "number" ? (p["containerCount"] as number) : null,
            containers: containerLabels(p["containers"] as ContainerHead[] | undefined),
        };
        const lists: Array<["added" | "rescored", FindingHead[]]> = [
            ["added", (p["added"] as FindingHead[] | undefined) ?? []],
            ["rescored", (p["rescored"] as FindingHead[] | undefined) ?? []],
        ];
        for (const [list, findings] of lists) {
            for (const f of findings) {
                const reason = findingReason(f, list, criteria);
                if (!reason) continue;
                const acc = accumulatorFor(byVuln, f.vulnId);
                noteReason(acc, reason);
                if (!acc.item.eventIds.includes(event.id)) acc.item.eventIds.push(event.id);
                noteFinding(acc, f);
                noteImage(acc, image);
            }
        }
    }

    const items = [...byVuln.values()].map(({ item, images, packages, clusters }) => {
        const all = [...images.values()].sort((a, b) => (b.containerCount ?? 0) - (a.containerCount ?? 0));
        return {
            ...item,
            packages: [...packages].slice(0, PACKAGES_PER_ITEM),
            images: all.slice(0, IMAGES_PER_ITEM),
            imageCount: all.length,
            clusterIds: [...clusters],
        };
    });

    // Exploited first, then by contribution — the product's one ordering rule.
    items.sort((a, b) => {
        if (a.kevListed !== b.kevListed) return a.kevListed ? -1 : 1;
        if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore;
        return a.vulnId.localeCompare(b.vulnId);
    });

    return { items, eventIds, eventCount };
}

/**
 * The debounce. A mirror change reaches a fleet as a burst of scans spread
 * over tens of minutes; the pass waits until the burst has gone quiet
 * (`quietMs` without a new qualifying event) before it sends, so the
 * message names every image and not the first three. `maxDelayMs` caps the
 * wait: a fleet that never goes quiet still hears within the hour.
 *
 * `newestAt` is the newest qualifying event in the window (pending or not);
 * `oldestPendingAt` the oldest not yet sent. Pure so the rule is testable.
 */
export function shouldSendNow(input: {
    now: Date;
    newestAt: Date | null;
    oldestPendingAt: Date | null;
    quietMs: number;
    maxDelayMs: number;
}): boolean {
    if (!input.oldestPendingAt) return false;
    const quietFor = input.newestAt ? input.now.getTime() - input.newestAt.getTime() : Infinity;
    if (quietFor >= input.quietMs) return true;
    return input.now.getTime() - input.oldestPendingAt.getTime() >= input.maxDelayMs;
}
