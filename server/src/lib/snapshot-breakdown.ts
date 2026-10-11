import type { LensBucket } from "../db/finding-tier.js";
import type { SnapshotMetrics } from "../repositories/metrics.repository.js";

/**
 * A snapshot's counts, split along the two axes the Dashboard filters by —
 * whose image (`yours`, which includes the images nothing has decided, as
 * `?control=yours` does everywhere) and the findings lens bucket — so a
 * filtered trend is a sum of cells rather than a second history.
 *
 * Stored on the snapshot row as one jsonb value (`breakdown`). Cells, not a
 * row per filter combination: the combinations are sums of one another, and
 * six cells answer all nine without storing any number twice. `unknown` is
 * the bucket of packages no scan has classified; it is in "All" and in
 * neither lens, which is what the live lists do with it.
 */
export type SnapshotSide = "yours" | "third-party";

export type FindingCell = {
    critical: number;
    high: number;
    medium: number;
    low: number;
    /** Every finding in the cell, the unscored ones included. */
    total: number;
    /** The cell's share of the ADR 0007 sum, rounded at capture like the column. */
    risk: number;
};

export type SnapshotBreakdown = {
    v: 1;
    findings: Record<SnapshotSide, Record<LensBucket, FindingCell>>;
    components: Record<SnapshotSide, Record<LensBucket, number>>;
    /** Running containers per side. The lens does not apply: a container is not a finding. */
    containers: Record<SnapshotSide, number>;
};

export const SNAPSHOT_SIDES: readonly SnapshotSide[] = ["yours", "third-party"];
export const SNAPSHOT_BUCKETS: readonly LensBucket[] = ["application", "base", "unknown"];

export function emptyFindingCell(): FindingCell {
    return { critical: 0, high: 0, medium: 0, low: 0, total: 0, risk: 0 };
}

export function emptySnapshotBreakdown(): SnapshotBreakdown {
    const perBucket = <T>(make: () => T) =>
        Object.fromEntries(SNAPSHOT_BUCKETS.map((b) => [b, make()])) as Record<LensBucket, T>;
    return {
        v: 1,
        findings: { yours: perBucket(emptyFindingCell), "third-party": perBucket(emptyFindingCell) },
        components: { yours: perBucket(() => 0), "third-party": perBucket(() => 0) },
        containers: { yours: 0, "third-party": 0 },
    };
}

/** `images.control` → the side it is filtered under. Only `third-party` is not "yours". */
export function sideOfControl(control: string | null | undefined): SnapshotSide {
    return control === "third-party" ? "third-party" : "yours";
}

/** A snapshot's flat counted columns — what a chart reads. */
export type SnapshotCounts = Omit<SnapshotMetrics, "breakdown">;

export type SnapshotFilter = {
    control?: SnapshotSide | undefined;
    /** The parsed `?tier=` — the buckets asked for; undefined is "All". */
    lens?: readonly LensBucket[] | undefined;
};

export function isFiltered(filter: SnapshotFilter): boolean {
    return filter.control !== undefined || filter.lens !== undefined;
}

/**
 * The counted fields of a snapshot under a filter: the sum of the cells it
 * selects, in the shape of the unfiltered row so a chart cannot tell them
 * apart. Null when the row predates the breakdown — a filtered series starts
 * where recording did, rather than splicing org-wide numbers into it.
 */
export function projectSnapshot(
    breakdown: SnapshotBreakdown | null | undefined,
    filter: SnapshotFilter,
): SnapshotCounts | null {
    if (!breakdown || breakdown.v !== 1) return null;
    const sides = filter.control ? [filter.control] : SNAPSHOT_SIDES;
    const buckets = filter.lens ?? SNAPSHOT_BUCKETS;

    const out: SnapshotCounts = {
        totalVulnerabilities: 0,
        totalWorkloads: 0,
        totalComponents: 0,
        criticalVulnerabilities: 0,
        highVulnerabilities: 0,
        mediumVulnerabilities: 0,
        lowVulnerabilities: 0,
        riskScore: 0,
    };
    for (const side of sides) {
        out.totalWorkloads += breakdown.containers[side] ?? 0;
        for (const bucket of buckets) {
            const cell = breakdown.findings[side]?.[bucket];
            if (cell) {
                out.criticalVulnerabilities += cell.critical;
                out.highVulnerabilities += cell.high;
                out.mediumVulnerabilities += cell.medium;
                out.lowVulnerabilities += cell.low;
                out.totalVulnerabilities += cell.total;
                out.riskScore += cell.risk;
            }
            out.totalComponents += breakdown.components[side]?.[bucket] ?? 0;
        }
    }
    return out;
}
