/**
 * The per-image rollup behind the fixes surface.
 *
 * The unit of remediation is an image: forty workloads running six distinct
 * images is six moves, not forty rows and not two thousand findings. This
 * module folds every counted finding of the org into one row per image —
 * buckets, EOL lines, the measured tag move when one exists — and hands the
 * rows to `suggestion.service.ts`, which ranks them into the suggestion feed
 * that `remediation.service.ts` turns into the Fixes list.
 *
 * ## The fixable / unfixable split
 *
 * A null `fixedVersion` is two different situations, and collapsing them is
 * what makes people stop trusting the number:
 *
 * - **awaiting-fix** — the advisory has no fix published yet; wait and track.
 * - **eol** — the release line named by `matchedEcosystem` no longer ships
 *   fixes; the action is "migrate the base image", different and larger work.
 *
 * `lib/eol-releases.ts` makes that call, and an ecosystem it cannot judge is
 * bucketed as awaiting-fix — the claim that asserts nothing about the
 * customer's base image.
 */

import { imageRepository } from "../repositories/image.repository.js";
import { remediationRepository } from "../repositories/remediation.repository.js";
import { upgradeScanForOrg, type TagCandidate, type UpgradeAvailability } from "./upgrade-recommendation.service.js";
import { buildSuggestionsForOrg, type Suggestion } from "./suggestion.service.js";
import { clusterRepository } from "../repositories/cluster.repository.js";
import { eolVerdict } from "../lib/eol-releases.js";
import { addSeverity, emptySeverityCounts, type SeverityCounts } from "../db/findings.js";
import type { ControlSignal, ImageControl } from "../lib/image-control.js";
import type { RiskRollup } from "../db/risk.js";

export interface FindingBuckets {
    total: number;
    /** An advisory names a fixed version. Kernel and glibc findings inflate it. */
    fixable: number;
    /** The part of `fixable` on packages the customer's build added — a dependency bump away. */
    fixableByYou: number;
    awaitingFix: number;
    eol: number;
    /** The row must agree with its buckets. */
    bySeverity: SeverityCounts;
}

export interface EolLine {
    releaseLine: string;
    eolDate: string;
    findings: number;
}

export interface FixRow {
    image: {
        id: string;
        digest: string;
        registry: string | null;
        repository: string | null;
        clusterId: string;
        clusterName: string | null;
        tags: string[];
        /** Who controls the image (`lib/image-control.ts`) and what decided it. */
        control: ImageControl;
        controlDetectedBy: ControlSignal | null;
        controlDetail: string | null;
    };
    workloadCount: number;
    containerCount: number;
    findings: FindingBuckets;
    /** The EOL release lines behind the `eol` bucket, largest first. */
    eolLines: EolLine[];
    risk: RiskRollup | null;
    /** The measured move, when one exists — phase 3's machinery. */
    upgrade: { best: TagCandidate; currentTag: string | null } | null;
    /**
     * Why `upgrade` is null when it is — the tag-axis scan's own verdict, so
     * a surface listing images without a move can say which of the four
     * reasons applies instead of rendering silence. `no-candidates` also
     * covers an image the scan never examined: its repository runs at one
     * scanned digest in this org, which is that verdict by construction.
     */
    upgradeAvailability: UpgradeAvailability;
}

export interface FixRollup {
    /** The scope applied, echoed back. `null` = the whole org. */
    clusterId: string | null;
    /** Every cluster in the org, for the selector. */
    clusters: Array<{ id: string; name: string }>;
    /** The primary surface: typed, ranked moves. See suggestion.service.ts. */
    suggestions: Suggestion[];
    rows: FixRow[];
    totals: {
        images: number;
        workloads: number;
        /** Running containers the rows' images back — what the UI prints. */
        containers: number;
        findings: Omit<FindingBuckets, "bySeverity">;
        measuredUpgrades: number;
        suggestions: { total: number; measured: number; unmeasured: number };
    };
}

/**
 * Fold one image's rollup cells into buckets. Exported for the unit test —
 * the EOL-vs-awaiting call is the part of the rollup that must not regress.
 *
 * The risk sums ride along for the suggestion feed: `fixableRiskSum` is the
 * "could address up to" upper bound of an unmeasured chart bump, and
 * `eolRiskSum` is the impact band an EOL advisory ranks within. Plain sums
 * of advisory scores — since ADR 0007 the same arithmetic as the aggregate
 * itself, so the ceiling is exact rather than a deliberate overstatement.
 */
export function foldBuckets(
    cells: Array<{
        fixable: boolean;
        byYou?: boolean;
        matchedEcosystem: string | null;
        severityLevel: string | null;
        count: number;
        riskSum?: number;
    }>,
    now: Date = new Date(),
): {
    buckets: FindingBuckets;
    eolLines: EolLine[];
    fixableRiskSum: number;
    eolRiskSum: number;
} {
    const buckets: FindingBuckets = {
        total: 0,
        fixable: 0,
        fixableByYou: 0,
        awaitingFix: 0,
        eol: 0,
        bySeverity: emptySeverityCounts(),
    };
    const eolByLine = new Map<string, EolLine>();
    let fixableRiskSum = 0;
    let eolRiskSum = 0;

    for (const cell of cells) {
        buckets.total += cell.count;
        addSeverity(buckets.bySeverity, cell.severityLevel, cell.count);
        if (cell.fixable) {
            buckets.fixable += cell.count;
            if (cell.byYou) buckets.fixableByYou += cell.count;
            fixableRiskSum += cell.riskSum ?? 0;
            continue;
        }
        const verdict = eolVerdict(cell.matchedEcosystem, now);
        if (verdict?.eol) {
            buckets.eol += cell.count;
            eolRiskSum += cell.riskSum ?? 0;
            const line = eolByLine.get(verdict.releaseLine);
            if (line) line.findings += cell.count;
            else
                eolByLine.set(verdict.releaseLine, {
                    releaseLine: verdict.releaseLine,
                    eolDate: verdict.eolDate,
                    findings: cell.count,
                });
        } else {
            buckets.awaitingFix += cell.count;
        }
    }

    return {
        buckets,
        eolLines: [...eolByLine.values()].sort((a, b) => b.findings - a.findings),
        fixableRiskSum,
        eolRiskSum,
    };
}

/**
 * The suggestion feed plus the per-image accounting it is built from.
 *
 * `clusterId` scopes both — every suggestion is inherently cluster-scoped
 * (`helm_releases` and `images` both key on the cluster), so scoping is a
 * read-time filter, not a different query. An unknown cluster id yields an
 * empty scope rather than an error: the id space is org-checked by the
 * filter itself.
 */
export async function fixRollupForOrg(orgId: string, clusterId: string | null = null): Promise<FixRollup> {
    const [stats, cells, workloadCounts, scan, orgClusters] = await Promise.all([
        imageRepository.findAllWithStats(orgId),
        remediationRepository.fixRollup(orgId),
        remediationRepository.workloadCountsByImage(orgId),
        upgradeScanForOrg(orgId),
        clusterRepository.findAllByOrg(orgId),
    ]);

    // Available moves, best first (ascending `riskChange`: negative is an
    // improvement), taken from the one scan so the refusals stay in hand.
    const upgrades = scan.settled
        .filter((r) => r.availability === "available")
        .sort((a, b) => (a.best?.summary.riskChange ?? 0) - (b.best?.summary.riskChange ?? 0));
    const availabilityByImage = new Map(scan.settled.map((r) => [r.current.imageId, r.availability]));

    const cellsByImage = new Map<string, typeof cells>();
    for (const cell of cells) {
        const list = cellsByImage.get(cell.imageId);
        if (list) list.push(cell);
        else cellsByImage.set(cell.imageId, [cell]);
    }
    const upgradeByImage = new Map(upgrades.map((u) => [u.current.imageId, u]));

    const rows: FixRow[] = [];
    const riskSums = new Map<string, { fixableRiskSum: number; eolRiskSum: number }>();
    for (const image of stats) {
        if (clusterId != null && image.clusterId !== clusterId) continue;
        const { buckets, eolLines, fixableRiskSum, eolRiskSum } = foldBuckets(cellsByImage.get(image.id) ?? []);
        if (buckets.total === 0) continue;

        riskSums.set(image.id, { fixableRiskSum, eolRiskSum });
        const upgrade = upgradeByImage.get(image.id);
        rows.push({
            image: {
                id: image.id,
                digest: image.digest,
                registry: image.registry,
                repository: image.repository,
                clusterId: image.clusterId,
                clusterName: image.clusterName,
                tags: image.tags,
                control: image.control,
                controlDetectedBy: image.controlDetectedBy,
                controlDetail: image.controlDetail,
            },
            workloadCount: workloadCounts.get(image.id) ?? 0,
            containerCount: image.containerCount,
            findings: buckets,
            eolLines,
            risk: image.risk,
            upgrade: upgrade?.best != null ? { best: upgrade.best, currentTag: upgrade.current.tag } : null,
            upgradeAvailability: availabilityByImage.get(image.id) ?? "no-candidates",
        });
    }

    rows.sort((a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1));

    const suggestions = await buildSuggestionsForOrg({ orgId, rows, upgrades, riskSums });

    const totals = {
        images: rows.length,
        workloads: rows.reduce((n, r) => n + r.workloadCount, 0),
        containers: rows.reduce((n, r) => n + r.containerCount, 0),
        findings: {
            total: rows.reduce((n, r) => n + r.findings.total, 0),
            fixable: rows.reduce((n, r) => n + r.findings.fixable, 0),
            fixableByYou: rows.reduce((n, r) => n + r.findings.fixableByYou, 0),
            awaitingFix: rows.reduce((n, r) => n + r.findings.awaitingFix, 0),
            eol: rows.reduce((n, r) => n + r.findings.eol, 0),
        },
        measuredUpgrades: rows.filter((r) => r.upgrade != null).length,
        suggestions: {
            total: suggestions.length,
            measured: suggestions.filter((s) => s.measured).length,
            unmeasured: suggestions.filter((s) => !s.measured).length,
        },
    };

    return {
        clusterId,
        clusters: orgClusters.map((c) => ({ id: c.id, name: c.name })),
        suggestions,
        rows,
        totals,
    };
}
