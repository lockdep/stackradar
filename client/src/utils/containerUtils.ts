import type { SortColumn, SortDirection, VulnerabilityCounts, Container, ContainerFilter } from '@/types/container';
import type { RiskBand } from '@/lib/risk';

function empty(): VulnerabilityCounts {
    return { critical: 0, high: 0, medium: 0, low: 0 };
}

function add(into: VulnerabilityCounts, from: VulnerabilityCounts): void {
    into.critical += from.critical;
    into.high += from.high;
    into.medium += from.medium;
    into.low += from.low;
}

/**
 * Total findings across a set of running containers, **counted once per image**.
 *
 * The deduplication is the whole point and the easiest thing to get wrong. A
 * finding is a property of an image; five containers running one image share
 * one finding, and summing per container reports it five times. That is exactly
 * what the old model did — five projects, five SBOMs, five sets of counts — and
 * it is why an org running one vulnerable base image everywhere saw a number
 * that tracked its container count rather than its risk.
 *
 * Images with `vulnerabilities: null` contribute nothing: nobody has scanned
 * them, and counting them as zero would report an unscanned fleet as clean.
 */
export function getTotalVulnerabilities(containers: Container[]): VulnerabilityCounts {
    const totals = empty();
    const counted = new Set<string>();

    for (const w of containers) {
        if (!w.vulnerabilities) continue;
        if (counted.has(w.imageId)) continue;
        counted.add(w.imageId);
        add(totals, w.vulnerabilities);
    }

    return totals;
}

/**
 * The findings and the fixable packages for a set of containers, or `null` for
 * both when **nothing in the set has been scanned**.
 *
 * The null is the whole reason this exists next to `getTotalVulnerabilities`.
 * That function answers "how many findings are in here", and zero is a correct
 * answer for a set nobody has looked at. This one answers "what do we know
 * about this group", where zero would be a claim — a namespace of thirty
 * unscanned containers rendering four zeroes is the product telling someone
 * their cluster is clean because it has never opened it.
 *
 * One scanned image among thirty unscanned ones is enough to produce numbers:
 * they are then true and incomplete, which the coverage strip above the table
 * is there to say.
 */
export function getScannedTotals(containers: Container[]): {
    vulnerabilities: VulnerabilityCounts | null;
    fixableComponents: number | null;
    risk: number | null;
    riskBand: RiskBand | null;
} {
    const totals = empty();
    const counted = new Set<string>();
    let fixable = 0;
    let anyScanned = false;
    let riskSum = 0;
    let worstBand: RiskBand = 'none';

    for (const w of containers) {
        if (!w.vulnerabilities) continue;
        anyScanned = true;
        if (counted.has(w.imageId)) continue;
        counted.add(w.imageId);
        add(totals, w.vulnerabilities);
        fixable += w.fixableComponents ?? 0;
        // The group's total is the sum of its distinct images' totals — legal
        // arithmetic, not a re-derivation, because the server's aggregate is a
        // plain sum since ADR 0007 and a sum composes. The image dedup above
        // is what keeps the equality honest. The band is the worst image's
        // band (itself the band of that image's worst finding), because
        // colour answers urgency and the total answers magnitude.
        riskSum += w.risk?.score ?? 0;
        if (w.risk && bandRank(w.risk.band) > bandRank(worstBand)) worstBand = w.risk.band;
    }

    if (!anyScanned) return { vulnerabilities: null, fixableComponents: null, risk: null, riskBand: null };
    return { vulnerabilities: totals, fixableComponents: fixable, risk: riskSum, riskBand: worstBand };
}

/** Bands are ordinal; stated once so "worse band" is not re-derived per caller. */
const BAND_ORDER: RiskBand[] = ['none', 'low', 'medium', 'high', 'critical'];
function bandRank(band: RiskBand): number {
    return BAND_ORDER.indexOf(band);
}

/**
 * The ranking decision, stated once.
 *
 * Weights rather than a sum: one critical outranks any number of highs, and no
 * quantity of mediums reaches a high. `low` is excluded on purpose — it never
 * decides an order, and including it makes two otherwise-equal rows swap places
 * on noise.
 *
 * **`null` scores below zero.** Unscanned is not clean, and this is the single
 * place that distinction is easy to lose: sorting an unscanned fleet worst-first
 * and finding an empty top would be a lie the sort itself was telling. Because
 * the score is below every real score, unscanned rows land at the bottom of a
 * descending sort and at the top of an ascending one, where "least is known"
 * belongs.
 */
export function severityScore(v: VulnerabilityCounts | null): number {
    if (!v) return -1;
    return v.critical * 1_000_000 + v.high * 1_000 + v.medium;
}

/**
 * The filter predicates, in one place so the coverage strip and the URL cannot
 * drift apart on what a word means. Every one is a question about a *row*,
 * and they compose with `AND`.
 */
const PREDICATES: Record<ContainerFilter, (w: Container) => boolean> = {
    /* No SBOM — the same thing the Scanned column and the coverage strip mean,
       and deliberately not `vulnerabilities === null`, which also catches an
       image that has an SBOM and is still queued for matching. */
    unscanned: (w) => w.sbomId === null,
};

/** True when `container` survives every active filter. */
export function matchesFilters(container: Container, filters: Set<ContainerFilter>): boolean {
    for (const filter of filters) {
        if (!PREDICATES[filter](container)) return false;
    }
    return true;
}

/** One rendered group in the containers list — a namespace. */
export type ContainerGroup = {
    /** Stable across renders and unique within the list — used as the row key. */
    key: string;
    label: string;
    containers: Container[];
    /**
     * Deduplicated by image, and **`null` when no image in the group has been
     * scanned** — see `getScannedTotals`. A group of unscanned containers
     * rendering four zeroes is the one thing this list must never do.
     */
    vulnerabilities: VulnerabilityCounts | null;
    /** Packages to bump across the group's distinct images. `null` = unscanned. */
    fixableComponents: number | null;
    /**
     * The sum of the group's distinct images' totals — the group's own total,
     * because the aggregate is a plain sum since ADR 0007 and a sum composes.
     * Deduplicated by image like every other group figure.
     */
    risk: number | null;
    /** The worst image's band — urgency, where `risk` is magnitude. */
    riskBand: RiskBand | null;
};

/** Short digest, for a group label where the full 71 characters do not fit. */
export function shortDigest(digest: string): string {
    const hex = digest.includes(':') ? digest.slice(digest.indexOf(':') + 1) : digest;
    return hex.slice(0, 12);
}

/**
 * Group running containers by namespace.
 *
 * Grouping is a read-time choice rather than a storage hierarchy — the model
 * stores flat `workload_containers` rows, and every container is inside a
 * namespace, so the grouping is total: no unattributed bucket to explain.
 *
 * Group totals are deduplicated by image just like the org total — see
 * `getScannedTotals`.
 */
export function groupContainers(containers: Container[]): ContainerGroup[] {
    const groups = new Map<string, ContainerGroup>();

    for (const w of containers) {
        const key = `ns:${w.namespaceId}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                key,
                label: w.namespaceName,
                containers: [],
                vulnerabilities: null,
                fixableComponents: null,
                risk: null,
                riskBand: null,
            };
            groups.set(key, group);
        }
        group.containers.push(w);
    }

    for (const group of groups.values()) {
        const totals = getScannedTotals(group.containers);
        group.vulnerabilities = totals.vulnerabilities;
        group.fixableComponents = totals.fixableComponents;
        group.risk = totals.risk;
        group.riskBand = totals.riskBand;
    }

    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Order the rows inside a group.
 *
 * Name is the fallback for every other key, so two rows that tie on severity or
 * on scan time stay in a stable, readable order instead of swapping on whatever
 * the fetch happened to return.
 */
export function compareContainers(
    a: Container,
    b: Container,
    column: SortColumn | null,
    direction: SortDirection,
): number {
    const byName = a.workloadName.localeCompare(b.workloadName) || a.name.localeCompare(b.name);

    if (column === 'risk') {
        // `null` below zero, same rule as `severityScore`: unscanned is not
        // clean, and a worst-first sort that opens with the rows nobody has
        // looked at is a lie the sort itself is telling.
        const delta = (a.risk?.score ?? -1) - (b.risk?.score ?? -1);
        if (delta !== 0) return direction === 'desc' ? -delta : delta;
        return byName;
    }

    if (column === 'severity') {
        const delta = severityScore(a.vulnerabilities) - severityScore(b.vulnerabilities);
        if (delta !== 0) return direction === 'desc' ? -delta : delta;
        return byName;
    }

    if (column === 'scannedAt') {
        // The column displays the last advisory match; sort by the same value
        // so the order matches what the eye sees. SBOM date fills in for rows
        // whose first match hasn't completed yet.
        const at = new Date(a.lastMatchedAt ?? a.scannedAt ?? 0).getTime();
        const bt = new Date(b.lastMatchedAt ?? b.scannedAt ?? 0).getTime();
        if (at !== bt) return direction === 'desc' ? bt - at : at - bt;
        return byName;
    }

    if (column === 'onImage') {
        // `desc` is longest first, so the *earliest* start leads. A container
        // with no interval recorded sorts last either way: unknown is not
        // "just deployed".
        const at = a.onImageSince ? new Date(a.onImageSince).getTime() : null;
        const bt = b.onImageSince ? new Date(b.onImageSince).getTime() : null;
        if (at === null || bt === null) return at === bt ? byName : at === null ? 1 : -1;
        if (at !== bt) return direction === 'desc' ? at - bt : bt - at;
        return byName;
    }

    return column === 'name' && direction === 'desc' ? -byName : byName;
}

/**
 * Apply a sort to the whole list — the groups *and* the rows inside them.
 *
 * Both, or the top of the list is not the worst thing in the cluster: reordering
 * rows within a namespace while the namespaces stay alphabetical buries a
 * critical under a group whose name starts with `z`.
 *
 * One rule that only looks like an exception: **groups reorder for severity,
 * not for scan time.** A group has no scan time. Synthesising one from the max
 * or the min of its rows would be a new claim invented to fill a column, and
 * neither answer is the group's.
 */
export function sortGroups(
    groups: ContainerGroup[],
    column: SortColumn | null,
    direction: SortDirection,
): ContainerGroup[] {
    for (const group of groups) {
        group.containers.sort((a, b) => compareContainers(a, b, column, direction));
    }

    if (column === 'risk') {
        return [...groups].sort((a, b) => {
            const delta = (a.risk ?? -1) - (b.risk ?? -1);
            if (delta !== 0) return direction === 'desc' ? -delta : delta;
            return a.label.localeCompare(b.label);
        });
    }

    if (column === 'severity') {
        return [...groups].sort((a, b) => {
            const delta = severityScore(a.vulnerabilities) - severityScore(b.vulnerabilities);
            if (delta !== 0) return direction === 'desc' ? -delta : delta;
            return a.label.localeCompare(b.label);
        });
    }

    if (column === 'name') {
        return [...groups].sort((a, b) => {
            const byLabel = a.label.localeCompare(b.label);
            return direction === 'desc' ? -byLabel : byLabel;
        });
    }

    return groups;
}
