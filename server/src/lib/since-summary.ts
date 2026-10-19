import type { ActivityEvent } from "../db/schema/remediation.js";
import type { SeverityBreakdown } from "../db/finding-delta.js";

/**
 * The weekly digest's "what changed" — the activity log between two
 * instants, folded into five facts. A pure function over `activity_events`
 * rows (`digest.service.ts`). The Dashboard's in-app counterpart is
 * `recent-movement.ts`, which folds the same scan and move events per image.
 *
 * The vocabulary is the Feed page's (`client/src/components/feed/dayGroups.ts`),
 * and so are its exclusions: a first scan is inventory, not change, and a
 * Job or CronJob pod starting or stopping is not a workload being tracked or
 * dropped. What is counted:
 *
 * - **new findings** — findings that arrived on already-running images
 *   because the advisory database changed (`scan.findings-changed` with cause
 *   `mirror` or `upload`), plus findings a container move introduced;
 * - **new KEV** — the subset of those on CISA's catalogue, by advisory id,
 *   plus advisories CISA listed while they were already running
 *   (`finding.kev-listed`);
 * - **containers tracked / untracked** — `container.appeared` / `.removed`;
 * - **resolved findings** — findings that left, by band, from scans and moves.
 *
 * Counts are exact where the payload carries exact counts (`addedBySeverity`,
 * `addedCount`); the KEV list is read from the payload's head list, which is
 * exact up to a hundred findings per event.
 */

export type SeverityBand = "critical" | "high" | "medium" | "low";

export interface SinceSummary {
    since: Date;
    until: Date;
    /** Distinct clusters the counted events touched. */
    clusterIds: string[];
    newFindings: { count: number; bySeverity: SeverityBreakdown; worst: SeverityBand | null };
    /** Advisory ids that arrived on KEV this window, worst first, deduplicated. */
    newKev: { count: number; vulnIds: string[] };
    containersTracked: number;
    containersUntracked: number;
    resolvedFindings: { count: number; bySeverity: SeverityBreakdown };
    /** Container moves (`container.image-changed`). */
    containersMoved: number;
}

const EMPTY: SeverityBreakdown = { critical: 0, high: 0, medium: 0, low: 0, unscored: 0 };
const BANDS: SeverityBand[] = ["critical", "high", "medium", "low"];
const SCHEDULED_KINDS = new Set(["cronjob", "job"]);

type FindingHead = { vulnId: string; severityLevel: string | null; kevListed?: boolean };

function bucket(level: string | null | undefined): keyof SeverityBreakdown {
    const l = (level ?? "").toLowerCase();
    return (BANDS as string[]).includes(l) ? (l as SeverityBand) : "unscored";
}

function countHead(findings: FindingHead[]): SeverityBreakdown {
    const out = { ...EMPTY };
    for (const f of findings) out[bucket(f.severityLevel)] += 1;
    return out;
}

function addInto(target: SeverityBreakdown, more: SeverityBreakdown | undefined) {
    if (!more) return;
    for (const k of Object.keys(EMPTY) as (keyof SeverityBreakdown)[]) target[k] += more[k] ?? 0;
}

function scored(b: SeverityBreakdown): number {
    return b.critical + b.high + b.medium + b.low;
}

function worstOf(b: SeverityBreakdown): SeverityBand | null {
    return BANDS.find((band) => b[band] > 0) ?? null;
}

/**
 * Findings that arrived in base images in the window, and on how many images
 * — the digest's one line about the bucket its "Start here" rows leave out.
 * Read from the per-bucket counts events have carried since the component
 * tier plan; an older event says nothing about buckets and adds nothing, so
 * the line under-counts for one week after the deploy rather than guessing.
 */
export function baseImageArrivals(events: ActivityEvent[]): { findings: number; images: number } {
    const images = new Set<string>();
    let findings = 0;
    for (const event of events) {
        const p = event.payload as Record<string, unknown>;
        let base = 0;
        if (event.type === "scan.findings-changed" && p["cause"] !== "first-scan" && p["containerCount"] !== 0) {
            base = (p["addedByBucket"] as { base?: number } | undefined)?.base ?? 0;
        } else if (event.type === "container.image-changed") {
            base =
                (p["delta"] as { introducedByBucket?: { base?: number } } | null | undefined)?.introducedByBucket
                    ?.base ?? 0;
        }
        if (base > 0) {
            findings += base;
            if (event.imageId) images.add(event.imageId);
        }
    }
    return { findings, images: images.size };
}

export function summariseSince(events: ActivityEvent[], since: Date, until: Date): SinceSummary {
    const summary: SinceSummary = {
        since,
        until,
        clusterIds: [],
        newFindings: { count: 0, bySeverity: { ...EMPTY }, worst: null },
        newKev: { count: 0, vulnIds: [] },
        containersTracked: 0,
        containersUntracked: 0,
        resolvedFindings: { count: 0, bySeverity: { ...EMPTY } },
        containersMoved: 0,
    };
    const clusters = new Set<string>();
    const kev = new Set<string>();
    const touch = (event: ActivityEvent) => {
        if (event.clusterId) clusters.add(event.clusterId);
    };

    for (const event of events) {
        const p = event.payload as Record<string, unknown>;
        switch (event.type) {
            case "finding.kev-listed": {
                // CISA listed an advisory already running here: on KEV this
                // week, though no finding arrived (`services/kev-listing.service.ts`).
                if (typeof p["vulnId"] === "string") kev.add(p["vulnId"]);
                touch(event);
                break;
            }
            case "scan.findings-changed": {
                if (p["cause"] === "first-scan") break;
                const added = (p["added"] as FindingHead[] | undefined) ?? [];
                const removed = (p["removed"] as FindingHead[] | undefined) ?? [];
                const addedBy = (p["addedBySeverity"] as SeverityBreakdown | undefined) ?? countHead(added);
                const removedBy = (p["removedBySeverity"] as SeverityBreakdown | undefined) ?? countHead(removed);
                addInto(summary.newFindings.bySeverity, addedBy);
                addInto(summary.resolvedFindings.bySeverity, removedBy);
                for (const f of added) if (f.kevListed) kev.add(f.vulnId);
                if (scored(addedBy) > 0 || scored(removedBy) > 0) touch(event);
                break;
            }
            case "container.image-changed": {
                summary.containersMoved += 1;
                touch(event);
                const delta = p["delta"] as
                    { introduced?: number; resolved?: number; introducedKev?: number } | null | undefined;
                /* A move's delta carries totals, not bands: count them as
                   unscored-agnostic totals so the headline is right, and
                   leave the per-band breakdown to the scans. */
                if (delta) {
                    summary.newFindings.count += delta.introduced ?? 0;
                    summary.resolvedFindings.count += delta.resolved ?? 0;
                    summary.newKev.count += delta.introducedKev ?? 0;
                }
                break;
            }
            case "container.appeared":
            case "container.removed": {
                const kind = ((p["workloadKind"] as string | null) ?? "").toLowerCase();
                if (SCHEDULED_KINDS.has(kind)) break;
                if (event.type === "container.appeared") summary.containersTracked += 1;
                else summary.containersUntracked += 1;
                touch(event);
                break;
            }
            default:
                break;
        }
    }

    summary.newFindings.count += scored(summary.newFindings.bySeverity);
    summary.newFindings.worst = worstOf(summary.newFindings.bySeverity);
    summary.resolvedFindings.count += scored(summary.resolvedFindings.bySeverity);
    summary.newKev.vulnIds = [...kev];
    summary.newKev.count += kev.size;
    summary.clusterIds = [...clusters];
    return summary;
}
