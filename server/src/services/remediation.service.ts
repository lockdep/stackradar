/**
 * From findings to fixes —
 * [remediation-workflow.md](../../../docs/proposals/remediation-workflow.md),
 * with the lifecycle renamed and widened by
 * [issues-workflow.md](../../../docs/proposals/issues-workflow.md).
 *
 * The unit of remediation is an image: forty workloads running six distinct
 * images is six moves, not forty rows and not two thousand findings. This
 * service produces that list (phase 1), attaches the command that delivers
 * each move (phase 2), and runs the issue lifecycle whose closing state is
 * written by the sweeps rather than by the user (phase 4).
 *
 * ## The two surfaces
 *
 * A **suggestion** is a computed claim — recomputed at read time, never
 * stored. An **issue** is a tracked commitment the user creates from one (or
 * from a finding): subject-bound, lifecycled, closed by evidence. `verified`
 * stays the machine's word — the inventory sweep for image and release
 * issues, the post-scan sweep for finding issues — and the user's own exit is
 * `closed`, with a mandatory reason.
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
 *
 * ## What suppression does and does not touch
 *
 * An unexpired `finding_states` row moves a finding out of its bucket and
 * into a `suppressed` count on the same row. It does **not** move the image's
 * risk score: the score is the org-wide ranking number every other surface
 * reports, and quietly deflating it here would be automatic suppression of
 * the ranking — the thing the proposal forbids. A suppressed KEV critical
 * still ranks its image; the row says why the finding count looks smaller.
 */

import { imageRepository } from "../repositories/image.repository.js";
import { helmReleaseRepository } from "../repositories/helm-release.repository.js";
import {
    remediationRepository,
    findingIssueKey,
    type FindingIssueStatus,
    type ImageFindingRow,
} from "../repositories/remediation.repository.js";
import {
    ownerMetadataKnown,
    recommendForImage,
    upgradeScanForOrg,
    type ImageUpgradeRecommendation,
    type TagCandidate,
    type UpgradeAvailability,
} from "./upgrade-recommendation.service.js";
import {
    buildDelivery,
    buildReleaseUpgradeCommand,
    type DeliveryInstruction,
} from "../lib/remediation-commands.js";
import {
    buildSuggestionsForOrg,
    type ChartUpgradeSuggestion,
    type ImageSuggestion,
    type Suggestion,
    type SuggestionCluster,
    type UnmeasuredChartSuggestion,
} from "./suggestion.service.js";
import type { VersionBump } from "../lib/image-tags.js";
import { clusterRepository } from "../repositories/cluster.repository.js";
import { eolVerdict } from "../lib/eol-releases.js";
import { addSeverity, emptySeverityCounts, type SeverityCounts } from "../db/findings.js";
import { imageRiskScores, releaseRiskScores } from "../db/risk.js";
import { db, schema } from "../db/index.js";
import { and, eq, isNotNull } from "drizzle-orm";
import { AppError } from "../middleware/error-handler.js";
import { emptyTierCounts, passesLens, type TierCounts, type TierLens } from "../db/finding-tier.js";
import { moveScope, type ScopeCounts } from "../db/finding-delta.js";
import type { ControlSignal, ImageControl } from "../lib/image-control.js";
import { chartIndexConfigured, chartIndexDelta } from "../lib/chart-index-client.js";
import { baseUpgradesForOrg, type BaseUpgradeRecommendation } from "./base-upgrade.service.js";
import { createLogger } from "../lib/logger.js";
import type {
    ActivityEvent,
    ActivityEventType,
    Issue,
    IssueClosedReason,
    IssueState,
} from "../db/schema/remediation.js";
import type { RiskRollup } from "../db/risk.js";

const log = createLogger("remediation");

/** Who did it — from the internal auth context, stored for attribution. */
export interface Actor {
    userId: string;
    email: string;
}

export interface FindingBuckets {
    total: number;
    /** An advisory names a fixed version. Kernel and glibc findings inflate it. */
    fixable: number;
    /** The part of `fixable` on packages the customer's build added — a dependency bump away. */
    fixableByYou: number;
    awaitingFix: number;
    eol: number;
    suppressed: number;
    /** Suppressed findings excluded — the row must agree with its buckets. */
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
    /** In-flight issues that target this image. */
    openIssues: number;
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
 * the EOL-vs-awaiting call is the part of phase 1 that must not regress.
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
        suppressed: boolean;
        matchedEcosystem: string | null;
        severityLevel: string | null;
        count: number;
        riskSum?: number;
    }>,
    now: Date = new Date()
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
        suppressed: 0,
        bySeverity: emptySeverityCounts(),
    };
    const eolByLine = new Map<string, EolLine>();
    let fixableRiskSum = 0;
    let eolRiskSum = 0;

    for (const cell of cells) {
        if (cell.suppressed) {
            buckets.suppressed += cell.count;
            continue;
        }
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
 * The Fix tab's data: the suggestion feed plus the per-image accounting.
 *
 * `clusterId` scopes both — every suggestion is inherently cluster-scoped
 * (`helm_releases` and `images` both key on the cluster), so scoping is a
 * read-time filter, not a different query. An unknown cluster id yields an
 * empty scope rather than an error: the id space is org-checked by the
 * filter itself.
 */
export async function fixRollupForOrg(
    orgId: string,
    clusterId: string | null = null
): Promise<FixRollup> {
    const [stats, cells, workloadCounts, openIssues, scan, orgClusters] = await Promise.all([
        imageRepository.findAllWithStats(orgId),
        remediationRepository.fixRollup(orgId),
        remediationRepository.workloadCountsByImage(orgId),
        remediationRepository.openIssueCountsByImage(orgId),
        upgradeScanForOrg(orgId),
        clusterRepository.findAllByOrg(orgId),
    ]);

    // The same selection `recommendationsForOrg` makes — available moves,
    // best first — taken from the one scan so the refusals stay in hand.
    const upgrades = scan.settled
        .filter((r) => r.availability === "available")
        .sort((a, b) => (a.best?.summary.riskChange ?? 0) - (b.best?.summary.riskChange ?? 0));
    const availabilityByImage = new Map(
        scan.settled.map((r) => [r.current.imageId, r.availability])
    );

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
        const { buckets, eolLines, fixableRiskSum, eolRiskSum } = foldBuckets(
            cellsByImage.get(image.id) ?? []
        );
        const open = openIssues.get(image.id) ?? 0;
        if (buckets.total === 0 && buckets.suppressed === 0 && open === 0) continue;

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
            upgrade:
                upgrade?.best != null
                    ? { best: upgrade.best, currentTag: upgrade.current.tag }
                    : null,
            upgradeAvailability: availabilityByImage.get(image.id) ?? "no-candidates",
            openIssues: open,
        });
    }

    rows.sort((a, b) => (b.risk?.score ?? -1) - (a.risk?.score ?? -1));

    const suggestions = await buildSuggestionsForOrg({
        orgId,
        rows,
        upgrades,
        riskSums,
        openIssuesByImage: openIssues,
    });

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
            suppressed: rows.reduce((n, r) => n + r.findings.suppressed, 0),
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

// ---------------------------------------------------------------------------
// The Fixes page — the suggestion feed as one ranked, read-only list
// ---------------------------------------------------------------------------

/**
 * One row of the Fixes page: a move the product can recommend, and what it
 * buys. A lens over the suggestion feed, not a second ranking — the order is
 * `rankKey`'s (measured first, KEV-clearing first, then risk removed), and
 * every row links to the detail page that carries the full panel and the
 * delivery command. EOL advisories are not fixes and land in
 * {@link NoRecommendationItem} instead.
 */
export interface FixListItem {
    id: string;
    /**
     * `image`: move a tag. `chart`: bump a chart. `base`: rebuild an image
     * the org builds on a newer base (`base-upgrade.service.ts`) — `subject`
     * is the image, `from` / `to` are the *base's* tags.
     */
    kind: "image" | "chart" | "base";
    /** Load-bearing: an unmeasured row may only say a newer chart *exists*. */
    measured: boolean;
    /**
     * What a measured row's numbers rest on. `sboms`: two SBOMs this org (or
     * the platform's candidate render) holds, diffed. `chart-index`: the
     * public chart index rendered and scored both chart versions on their
     * **default values** — real, but not this cluster's values, and the row
     * must say so. Null when unmeasured.
     */
    evidence: "sboms" | "chart-index" | null;
    /** What is being moved — `registry/repo` or the chart name. */
    subject: string;
    /** The release running the chart; null on the image axis. */
    release: { name: string; namespace: string } | null;
    from: string | null;
    to: string;
    bump: VersionBump;
    cluster: SuggestionCluster;
    /**
     * Which kind of action this is, for grouping: `application` when most of
     * what it clears is in packages the build added, `base` when most is in
     * the base image (a tie, and an unmeasured move, are `application`). A
     * package bump and a base rebuild are different kinds of work and rank
     * as such; the dedicated base-image rebuild of item 7 is always `base`.
     */
    scope: "application" | "base";
    /**
     * Who can make the move. `built`: an image the org builds — the move is in
     * its control. `third-party`: the move is an upstream upgrade (a public
     * chart's newer version, a vendor image's newer tag). An image nothing
     * has decided counts as `built`: over-recommending on it is cheap, hiding
     * a fix on an image the org builds is not.
     */
    control: "built" | "third-party";
    /**
     * What the move clears — null when unmeasured. `high` counts high *or*
     * critical; `byScope` splits `findings` into application packages and
     * the base image.
     */
    cleared: { findings: number; kev: number; high: number; introduced: number; byScope?: ScopeCounts } | null;
    /** Radar Score contribution the move removes — the rank key; null when unmeasured. */
    riskRemoved: number | null;
    /**
     * An unmeasured chart bump's "could address up to" bound: Σ risk and
     * count of currently-fixable findings on the release's images.
     */
    upperBound: { risk: number; findings: number } | null;
    /** Distinct workloads the move lands on (summed over a chart's images). */
    workloads: number;
    /** Running containers the move lands on (summed over a chart's images) — what the UI prints. */
    containers: number;
    images: number;
    /** How the change is delivered, in one phrase, when it can be said. */
    delivery: string | null;
    /** Where the full panel and commands live. */
    target: { type: "image"; imageId: string } | { type: "release"; releaseId: string };
}

/** Why an image with findings has no recommended move, in the service's own words. */
export type NoRecommendationReason = UpgradeAvailability | "eol";

export interface NoRecommendationItem {
    imageId: string;
    /** `third-party` rows are what "Waiting on upstream" counts. */
    control: "built" | "third-party";
    subject: string;
    currentTag: string | null;
    cluster: SuggestionCluster;
    findings: number;
    kev: number;
    risk: number | null;
    reason: NoRecommendationReason;
    /** The EOL lines behind an `eol` reason; empty otherwise. */
    eolLines: EolLine[];
}

export interface FixesPage {
    totals: {
        /** Measured moves — the ones that can say what they clear. */
        upgrades: number;
        findingsCleared: number;
        kevCleared: number;
    };
    fixes: FixListItem[];
    noRecommendation: NoRecommendationItem[];
    /**
     * Third-party images with findings and no upgrade to recommend — the
     * folded third group. There is nothing for the org to do about them but
     * wait, and saying so plainly is the point.
     */
    waitingOnUpstream: { images: number; findings: number };
}

function imageSubject(image: { registry?: string | null; repository: string | null; digest: string }): string {
    return image.repository ?? image.digest.slice(0, 19);
}

/**
 * A base rebuild as a row of the list: always the org's to do (`built`),
 * always `base` scope, and measured — the candidate base was scanned and the
 * image's base-bucket findings diffed against it.
 */
function baseFix(row: FixRow, rec: BaseUpgradeRecommendation): FixListItem | null {
    const best = rec.best;
    if (!best) return null;
    return {
        id: `base:${row.image.id}:${best.digest}`,
        kind: "base",
        measured: true,
        evidence: "sboms",
        subject: imageSubject(row.image),
        release: null,
        from: rec.base.ref,
        to: best.kind === "same-tag" ? `${best.ref} (rebuilt upstream)` : best.ref,
        bump: best.bump,
        cluster: { id: row.image.clusterId, name: row.image.clusterName },
        control: "built",
        scope: "base",
        cleared: {
            findings: best.removes,
            kev: best.removesKev,
            high: best.removesHigh,
            introduced: best.introduces,
            byScope: { application: 0, base: best.removes },
        },
        riskRemoved: best.riskRemoved,
        upperBound: null,
        workloads: row.workloadCount,
        containers: row.containerCount,
        images: 1,
        delivery: best.kind === "same-tag" ? "rebuild the image — no Dockerfile change" : "change the FROM line and rebuild",
        target: { type: "image", imageId: row.image.id },
    };
}

/** How many unmeasured rows ask the chart index at once. */
const CHART_INDEX_CONCURRENCY = 6;

/**
 * Ask the public chart index about the chart bumps nothing here could
 * measure, and promote the ones it answers. In place, bounded, and never
 * throwing: the client returns null for anything it cannot say, and a row
 * left alone is exactly what the page showed before the index existed.
 * The promoted row keeps `upperBound` — the index measured the chart's
 * default values, and the org's fixable findings are still the honest
 * ceiling for *this* release.
 */
async function measureFromChartIndex(
    asks: Array<{ fix: FixListItem; repoUrl: string; chart: string; from: string; to: string }>
): Promise<void> {
    if (asks.length === 0 || !chartIndexConfigured()) return;
    for (let i = 0; i < asks.length; i += CHART_INDEX_CONCURRENCY) {
        await Promise.all(
            asks.slice(i, i + CHART_INDEX_CONCURRENCY).map(async ({ fix, ...query }) => {
                const delta = await chartIndexDelta(query);
                if (!delta) return;
                fix.measured = true;
                fix.evidence = "chart-index";
                fix.cleared = {
                    findings: delta.summary.resolved,
                    kev: delta.summary.resolvedKev,
                    high: delta.summary.resolvedHigh,
                    introduced: delta.summary.introduced,
                };
                fix.riskRemoved = -delta.summary.riskChange;
            })
        );
    }
}

type EffectiveControl = "built" | "third-party";

const effectiveControl = (control: ImageControl | undefined): EffectiveControl =>
    control === "third-party" ? "third-party" : "built";

function imageFix(s: ImageSuggestion, controlByImage: ReadonlyMap<string, ImageControl>): FixListItem {
    const summary = s.best.summary;
    return {
        id: s.id,
        kind: "image",
        measured: true,
        evidence: "sboms",
        subject: imageSubject(s.image),
        release: s.pinnedBy
            ? { name: s.pinnedBy.releaseName, namespace: s.pinnedBy.releaseNamespace }
            : null,
        from: s.image.currentTag,
        to: s.best.tag,
        bump: s.best.bump,
        cluster: s.cluster,
        control: effectiveControl(controlByImage.get(s.image.id)),
        scope: moveScope(s.best.resolvedByScope),
        cleared: {
            findings: summary.resolved,
            kev: summary.resolvedKev,
            high: summary.resolvedHigh,
            introduced: summary.introduced,
            byScope: s.best.resolvedByScope,
        },
        riskRemoved: s.riskRemoved,
        upperBound: null,
        workloads: s.workloadCount,
        containers: s.containerCount,
        images: 1,
        delivery: s.deliveredBy
            ? `${s.deliveredBy.tool} app ${s.deliveredBy.appName}`
            : s.pinnedBy
              ? `values override on ${s.pinnedBy.releaseName}`
              : "kubectl set image",
        target: { type: "image", imageId: s.image.id },
    };
}

/**
 * A chart bump is an upstream upgrade when the chart is someone else's: it is
 * attributed to a public chart, or every image it moves is third-party. The
 * org's own chart moving its own images is in its control.
 */
function chartControl(
    release: { attributedRepoUrl?: string | null },
    imageIds: readonly string[],
    controlByImage: ReadonlyMap<string, ImageControl>
): EffectiveControl {
    if (release.attributedRepoUrl) return "third-party";
    if (imageIds.length === 0) return "built";
    return imageIds.every((id) => controlByImage.get(id) === "third-party") ? "third-party" : "built";
}

function chartFix(
    s: ChartUpgradeSuggestion,
    spreadByImage: Map<string, { workloads: number; containers: number }>,
    controlByImage: ReadonlyMap<string, ImageControl>
): FixListItem {
    const cleared = s.imageMoves.reduce(
        (acc, m) => ({
            findings: acc.findings + m.summary.resolved,
            kev: acc.kev + m.summary.resolvedKev,
            high: acc.high + m.summary.resolvedHigh,
            introduced: acc.introduced + m.summary.introduced,
            byScope: {
                application: acc.byScope.application + m.resolvedByScope.application,
                base: acc.byScope.base + m.resolvedByScope.base,
            },
        }),
        { findings: 0, kev: 0, high: 0, introduced: 0, byScope: { application: 0, base: 0 } }
    );
    return {
        id: s.id,
        kind: "chart",
        measured: true,
        evidence: "sboms",
        subject: s.release.chartName ?? s.release.name,
        release: { name: s.release.name, namespace: s.release.namespace },
        from: s.release.chartVersion,
        to: s.target.chartVersion,
        bump: s.bump,
        cluster: s.cluster,
        control: chartControl(s.release, s.imageMoves.map((m) => m.fromImageId), controlByImage),
        scope: moveScope(cleared.byScope),
        cleared,
        riskRemoved: s.riskRemoved,
        upperBound: null,
        // A workload running two of the moved images is counted once per
        // image here — the sum is "places the bump lands", not a distinct count.
        workloads: s.imageMoves.reduce((n, m) => n + (spreadByImage.get(m.fromImageId)?.workloads ?? 0), 0),
        containers: s.imageMoves.reduce((n, m) => n + (spreadByImage.get(m.fromImageId)?.containers ?? 0), 0),
        images: s.imageMoves.length,
        delivery: s.delivery
            ? `${s.delivery.tool} app ${s.delivery.appName}`
            : s.command
              ? "helm upgrade"
              : null,
        target: { type: "release", releaseId: s.release.id },
    };
}

function unmeasuredChartFix(
    s: UnmeasuredChartSuggestion,
    workloadsByRelease: Map<string, { workloads: number; containers: number; images: number }>
): FixListItem {
    const spread = workloadsByRelease.get(s.release.id) ?? { workloads: 0, containers: 0, images: 0 };
    return {
        id: s.id,
        kind: "chart",
        measured: false,
        evidence: null,
        subject: s.release.chartName ?? s.release.name,
        release: { name: s.release.name, namespace: s.release.namespace },
        from: s.release.chartVersion,
        to: s.targetVersion,
        bump: s.bump,
        cluster: s.cluster,
        // Nothing measured says which images it moves; a chart we could
        // attribute to a public one is upstream's, anything else is the org's.
        control: s.release.attributedRepoUrl ? "third-party" : "built",
        scope: "application",
        cleared: null,
        riskRemoved: null,
        upperBound: { risk: s.upperBoundRisk, findings: s.fixableFindings },
        workloads: spread.workloads,
        containers: spread.containers,
        images: spread.images,
        delivery: null,
        target: { type: "release", releaseId: s.release.id },
    };
}

/**
 * The Fixes page's data — `fixRollupForOrg` folded into the ranked list and
 * the "no recommendation yet" remainder.
 *
 * Every image with findings appears exactly once: in a measured fix (its
 * own tag move, or the chart bump that subsumes it), or in the remainder
 * with the scan's stated reason. An unmeasured chart bump does not claim
 * its images — it may only say a newer chart exists — so those images stay
 * in the remainder too. Nothing here is a write, and nothing implies a move
 * is safe.
 */
export async function fixesForOrg(orgId: string): Promise<FixesPage> {
    const [rollup, releaseSpread] = await Promise.all([
        fixRollupForOrg(orgId),
        remediationRepository.releaseSpread(orgId),
    ]);
    const spreadByImage = new Map(
        rollup.rows.map((r) => [r.image.id, { workloads: r.workloadCount, containers: r.containerCount }])
    );

    const controlByImage = new Map(rollup.rows.map((r) => [r.image.id, r.image.control]));

    const fixes: FixListItem[] = [];
    /** Unmeasured chart rows the public chart index might be able to measure. */
    const askIndex: Array<{ fix: FixListItem; repoUrl: string; chart: string; from: string; to: string }> = [];
    const coveredImages = new Set<string>();
    const eolByImage = new Map<string, EolLine[]>();

    for (const s of rollup.suggestions) {
        switch (s.type) {
            case "chart-upgrade":
                fixes.push(chartFix(s, spreadByImage, controlByImage));
                for (const m of s.imageMoves) coveredImages.add(m.fromImageId);
                for (const sub of s.subsumes) coveredImages.add(sub.image.id);
                break;
            case "image-tag-upgrade":
            case "image-override":
                fixes.push(imageFix(s, controlByImage));
                coveredImages.add(s.image.id);
                break;
            case "chart-newer-unmeasured": {
                const fix = unmeasuredChartFix(s, releaseSpread);
                fixes.push(fix);
                const repoUrl = s.release.repoUrl ?? s.release.attributedRepoUrl;
                if (repoUrl && s.release.chartName && s.release.chartVersion) {
                    askIndex.push({ fix, repoUrl, chart: s.release.chartName, from: s.release.chartVersion, to: s.targetVersion });
                }
                break;
            }
            case "eol-migration":
                eolByImage.set(s.image.id, s.lines);
                break;
        }
    }

    // Base rebuilds, for the images the org can rebuild. A third-party image's
    // base is upstream's business, and its one action is already on the list.
    const rebuildable = rollup.rows.filter((r) => r.image.control !== "third-party");
    const baseUpgrades = await baseUpgradesForOrg(orgId, rebuildable.map((r) => r.image.id)).catch((error: unknown) => {
        log.warn({ error, orgId }, "Could not assemble base-image rebuilds for the fix list");
        return new Map<string, BaseUpgradeRecommendation>();
    });
    for (const row of rebuildable) {
        const rec = baseUpgrades.get(row.image.id);
        const fix = rec ? baseFix(row, rec) : null;
        if (fix) fixes.push(fix);
    }

    await measureFromChartIndex(askIndex);
    // A row the index measured ranks with the measured ones. Stable
    // (`Array.prototype.sort` is stable): rows measured from SBOMs this org
    // holds keep their rank, the index's follow them, the unmeasured come last.
    fixes.sort((a, b) => Number(b.measured) - Number(a.measured));

    const noRecommendation: NoRecommendationItem[] = rollup.rows
        .filter((row) => row.findings.total > 0 && !coveredImages.has(row.image.id))
        .map((row) => {
            const eolLines = eolByImage.get(row.image.id) ?? [];
            // A fixable finding still has a tag-axis answer to give; only when
            // nothing on the image is fixable is EOL the whole story.
            const reason: NoRecommendationReason =
                eolLines.length > 0 && row.findings.fixable === 0 ? "eol" : row.upgradeAvailability;
            return {
                imageId: row.image.id,
                control: effectiveControl(row.image.control),
                subject: imageSubject(row.image),
                currentTag: row.image.tags[0] ?? null,
                cluster: { id: row.image.clusterId, name: row.image.clusterName },
                findings: row.findings.total,
                kev: row.risk?.kevCount ?? 0,
                risk: row.risk?.score ?? null,
                reason,
                eolLines,
            };
        });

    const measured = fixes.filter((f) => f.cleared != null);
    return {
        totals: {
            upgrades: measured.length,
            findingsCleared: measured.reduce((n, f) => n + (f.cleared?.findings ?? 0), 0),
            kevCleared: measured.reduce((n, f) => n + (f.cleared?.kev ?? 0), 0),
        },
        fixes,
        noRecommendation,
        waitingOnUpstream: {
            images: noRecommendation.filter((n) => n.control === "third-party").length,
            findings: noRecommendation.filter((n) => n.control === "third-party").reduce((n, i) => n + i.findings, 0),
        },
    };
}

// ---------------------------------------------------------------------------
// Phase 2 — one image, expanded: workloads, delivery, finding buckets
// ---------------------------------------------------------------------------

export interface FixImageDetail {
    upgrade: ImageUpgradeRecommendation;
    /** One entry per container running the image, with its instruction. */
    workloads: Array<{
        workloadId: string;
        workloadName: string;
        workloadKind: string | null;
        namespaceName: string;
        containerName: string;
        init: boolean;
        imageTag: string | null;
        runningPods: number | null;
        delivery: DeliveryInstruction;
    }>;
    findings: {
        fixable: LensedFindingRow[];
        awaitingFix: LensedFindingRow[];
        eol: Array<{ line: EolLine; findings: LensedFindingRow[] }>;
        suppressed: LensedFindingRow[];
    };
    /** Unsuppressed findings per tier-lens bucket, whatever lens was asked for. */
    tierCounts: TierCounts;
    issues: Issue[];
}

type LensedFindingRow = ImageFindingRow & { shownDespiteTier: boolean };

export async function imageRemediationDetail(
    orgId: string,
    imageId: string,
    tiers?: TierLens
): Promise<FixImageDetail> {
    const image = await imageRepository.findById(imageId);
    if (!image) throw new AppError(404, "Image not found");

    const [upgrade, targets, metadataKnown, allFindings, allIssues] = await Promise.all([
        recommendForImage(orgId, imageId),
        remediationRepository.findDeliveryTargets(imageId, orgId),
        ownerMetadataKnown(image.clusterId),
        remediationRepository.findingsForImage(orgId, imageId),
        remediationRepository.listIssues(orgId),
    ]);

    const targetTag = upgrade.best?.tag ?? null;
    const workloads = targets.map((t) => ({
        workloadId: t.workloadId,
        workloadName: t.workloadName,
        workloadKind: t.workloadKind,
        namespaceName: t.namespaceName,
        containerName: t.containerName,
        init: t.init,
        imageTag: t.imageTag,
        runningPods: t.runningPods,
        delivery: buildDelivery({
            workload: { name: t.workloadName, kind: t.workloadKind, namespace: t.namespaceName },
            containerName: t.containerName,
            imageRef: t.imageRef,
            currentTag: t.imageTag,
            targetTag,
            release: t.release?.id != null ? t.release : null,
            application: t.application?.id != null ? t.application : null,
            ownerMetadataKnown: metadataKnown,
        }),
    }));

    const tierCounts = emptyTierCounts();
    const findings: LensedFindingRow[] = [];
    for (const finding of allFindings) {
        if (!finding.suppression) {
            tierCounts.all += 1;
            if (finding.bucket === "application") tierCounts.application += 1;
            else if (finding.bucket === "base") tierCounts.base += 1;
        }
        if (!passesLens(finding, tiers)) continue;
        findings.push({
            ...finding,
            shownDespiteTier: tiers != null && !tiers.includes(finding.bucket),
        });
    }

    const now = new Date();
    const fixable: LensedFindingRow[] = [];
    const awaitingFix: LensedFindingRow[] = [];
    const suppressed: LensedFindingRow[] = [];
    const eolGroups = new Map<string, { line: EolLine; findings: LensedFindingRow[] }>();

    for (const finding of findings) {
        if (finding.suppression) {
            suppressed.push(finding);
            continue;
        }
        if (finding.fixedVersion != null) {
            fixable.push(finding);
            continue;
        }
        const verdict = eolVerdict(finding.matchedEcosystem, now);
        if (verdict?.eol) {
            const group = eolGroups.get(verdict.releaseLine);
            if (group) {
                group.line.findings += 1;
                group.findings.push(finding);
            } else {
                eolGroups.set(verdict.releaseLine, {
                    line: { releaseLine: verdict.releaseLine, eolDate: verdict.eolDate, findings: 1 },
                    findings: [finding],
                });
            }
        } else {
            awaitingFix.push(finding);
        }
    }

    return {
        upgrade,
        workloads,
        findings: {
            fixable,
            awaitingFix,
            eol: [...eolGroups.values()].sort((a, b) => b.line.findings - a.line.findings),
            suppressed,
        },
        tierCounts,
        issues: allIssues.filter((i) => i.imageId === imageId),
    };
}

// ---------------------------------------------------------------------------
// Phase 4 — the issue lifecycle and the verify loops
// ---------------------------------------------------------------------------

/**
 * `snoozed` with a past `snoozedUntil` reads as `open` — computed at read
 * time rather than swept by a job, so there is no window where a woken
 * issue is invisible.
 */
export function effectiveState(issue: Issue, now: Date = new Date()): IssueState {
    if (
        issue.state === "snoozed" &&
        (issue.snoozedUntil == null || issue.snoozedUntil.getTime() <= now.getTime())
    ) {
        return "open";
    }
    return issue.state;
}

const TERMINAL_STATES: ReadonlySet<IssueState> = new Set(["verified", "closed"]);

export interface CreateIssueInput {
    scope: "image" | "release" | "finding";
    imageId?: string | undefined;
    releaseId?: string | undefined;
    toTag?: string | undefined;
    toDigest?: string | undefined;
    toChartVersion?: string | undefined;
    vulnId?: string | undefined;
    packageType?: string | undefined;
    packageName?: string | undefined;
    notes?: string | undefined;
}

/**
 * Open an issue, snapshotting the facts that name it so the record outlives
 * the rows it points at. What it deliberately does not record: any claim the
 * move is safe, and any risk number — risk is folded at read time.
 */
export async function createIssue(
    orgId: string,
    actor: Actor,
    input: CreateIssueInput
): Promise<Issue> {
    let issue: Issue;

    if (input.scope === "image") {
        if (!input.imageId) throw new AppError(400, "imageId is required for an image issue");
        const image = await imageRepository.findById(input.imageId);
        if (!image || image.orgId !== orgId) throw new AppError(404, "Image not found");

        const tags = await db
            .selectDistinct({ tag: schema.workloadContainers.imageTag })
            .from(schema.workloadContainers)
            .where(
                and(
                    eq(schema.workloadContainers.imageId, image.id),
                    eq(schema.workloadContainers.orgId, orgId),
                    isNotNull(schema.workloadContainers.imageTag)
                )
            );

        issue = await remediationRepository.createIssue({
            orgId,
            clusterId: image.clusterId,
            scope: "image",
            imageId: image.id,
            repository: image.repository,
            fromDigest: image.digest,
            fromTag: tags[0]?.tag ?? null,
            toDigest: input.toDigest ?? null,
            toTag: input.toTag ?? null,
            createdByUserId: actor.userId,
            createdByEmail: actor.email,
            notes: input.notes ?? null,
        });
    } else if (input.scope === "release") {
        if (!input.releaseId)
            throw new AppError(400, "releaseId is required for a release issue");
        const release = await helmReleaseRepository.findById(input.releaseId);
        if (!release || release.orgId !== orgId) throw new AppError(404, "Release not found");
        if (!release.chartName)
            throw new AppError(400, "The release's chart is unknown, so a chart bump cannot be tracked");

        issue = await remediationRepository.createIssue({
            orgId,
            clusterId: release.clusterId,
            scope: "release",
            releaseId: release.id,
            chartName: release.chartName,
            fromChartVersion: release.chartVersion,
            toChartVersion: input.toChartVersion ?? null,
            createdByUserId: actor.userId,
            createdByEmail: actor.email,
            notes: input.notes ?? null,
        });
    } else {
        if (!input.vulnId || !input.packageType || !input.packageName)
            throw new AppError(400, "A finding issue needs vulnId, packageType and packageName");

        const identity = await remediationRepository.resolveVulnIdentity(input.vulnId);
        if (!identity) throw new AppError(404, `Advisory ${input.vulnId} not found`);

        // One in-flight issue per finding identity: a second "keep me
        // informed" on the same subject is noise, not a second commitment.
        const inFlight = await remediationRepository.findInFlightFindingIssues(orgId);
        const duplicate = inFlight.find(
            (i) =>
                i.packageType === input.packageType &&
                i.packageName === input.packageName &&
                i.vulnIdentity === identity
        );
        if (duplicate) {
            throw new AppError(409, "An issue is already open for this finding");
        }

        issue = await remediationRepository.createIssue({
            orgId,
            // A finding identity is org-wide by construction — no cluster.
            clusterId: null,
            scope: "finding",
            packageType: input.packageType,
            packageName: input.packageName,
            vulnIdentity: identity,
            vulnId: input.vulnId,
            createdByUserId: actor.userId,
            createdByEmail: actor.email,
            notes: input.notes ?? null,
        });
    }

    await emitIssueEvent("issue.created", issue);
    return issue;
}

export type IssueTransition =
    | { to: "snoozed"; snoozedUntil: Date }
    | { to: "applied" }
    | { to: "open" }
    | { to: "closed"; closedReason: IssueClosedReason; closedNote: string | null; actor: Actor };

const EVENT_BY_TRANSITION: Record<IssueTransition["to"], ActivityEventType> = {
    snoozed: "issue.snoozed",
    applied: "issue.applied",
    open: "issue.reopened",
    closed: "issue.closed",
};

/**
 * `open → snoozed(until) → applied → verified`, plus the manual exit
 * `closed`. `verified` is reachable only through the sweeps below; `closed`
 * requires a reason and attribution. Both are terminal — a finished issue is
 * history and stays put.
 */
export async function transitionIssue(
    orgId: string,
    id: string,
    transition: IssueTransition
): Promise<Issue> {
    const issue = await remediationRepository.findIssueById(id, orgId);
    if (!issue) throw new AppError(404, "Issue not found");
    if (TERMINAL_STATES.has(issue.state))
        throw new AppError(409, `A ${issue.state} issue is history and cannot change state`);

    if (transition.to === "snoozed" && transition.snoozedUntil.getTime() <= Date.now()) {
        throw new AppError(400, "snoozedUntil must be in the future");
    }

    const updated = await remediationRepository.updateIssue(id, orgId, {
        state: transition.to,
        snoozedUntil: transition.to === "snoozed" ? transition.snoozedUntil : null,
        appliedAt: transition.to === "applied" ? new Date() : null,
        closedAt: transition.to === "closed" ? new Date() : null,
        closedReason: transition.to === "closed" ? transition.closedReason : null,
        closedNote: transition.to === "closed" ? transition.closedNote : null,
        closedByUserId: transition.to === "closed" ? transition.actor.userId : null,
        closedByEmail: transition.to === "closed" ? transition.actor.email : null,
    });
    if (!updated) throw new AppError(404, "Issue not found");

    await emitIssueEvent(EVENT_BY_TRANSITION[transition.to], updated);
    return updated;
}

/**
 * One row of the Issues tab: the stored record plus everything computed at
 * read time. `currentRisk` is never stored (rule 2 of the reframe) — for an
 * image or release issue it is the summed risk of the subject's counted
 * findings *now* (ADR 0007); for a finding issue it is the worst matching
 * advisory's own `risk_score`, no fold, because a single finding is not a
 * group.
 */
export interface IssueListItem extends Issue {
    effectiveState: IssueState;
    clusterName: string | null;
    currentRisk: number | null;
    /** Read-time status of a finding issue's identity; null for other scopes. */
    finding: FindingIssueStatus | null;
}

export async function listIssues(
    orgId: string,
    filter: { state?: IssueState; clusterId?: string } = {}
): Promise<IssueListItem[]> {
    const [issues, clusters] = await Promise.all([
        remediationRepository.listIssues(
            orgId,
            filter.clusterId != null ? { clusterId: filter.clusterId } : {}
        ),
        clusterRepository.findAllByOrg(orgId),
    ]);
    const clusterNames = new Map(clusters.map((c) => [c.id, c.name]));

    const imageIds = [...new Set(issues.map((i) => i.imageId).filter((id): id is string => id != null))];
    const releaseIds = [
        ...new Set(issues.map((i) => i.releaseId).filter((id): id is string => id != null)),
    ];
    const findingKeys = issues
        .filter((i) => i.scope === "finding" && i.packageType && i.packageName && i.vulnIdentity)
        .map((i) => ({
            packageType: i.packageType!,
            packageName: i.packageName!,
            vulnIdentity: i.vulnIdentity!,
        }));

    const [imageRisk, releaseRisk, findingStatus] = await Promise.all([
        imageRiskScores(imageIds),
        releaseRiskScores(releaseIds),
        remediationRepository.findingIssueStatus(orgId, findingKeys),
    ]);

    const items = issues.map((issue): IssueListItem => {
        let currentRisk: number | null = null;
        let finding: FindingIssueStatus | null = null;
        if (issue.scope === "image" && issue.imageId != null) {
            currentRisk = imageRisk.get(issue.imageId)?.score ?? null;
        } else if (issue.scope === "release" && issue.releaseId != null) {
            currentRisk = releaseRisk.get(issue.releaseId)?.score ?? null;
        } else if (issue.scope === "finding") {
            finding = findingStatus.get(findingIssueKey(issue)) ?? {
                remaining: 0,
                maxRisk: null,
                fixAvailable: false,
                perCluster: [],
            };
            currentRisk = finding.maxRisk;
        }
        return {
            ...issue,
            effectiveState: effectiveState(issue),
            clusterName: issue.clusterId != null ? (clusterNames.get(issue.clusterId) ?? null) : null,
            currentRisk,
            finding,
        };
    });

    if (filter.state != null) {
        return items.filter((i) => i.effectiveState === filter.state);
    }
    return items;
}

/**
 * One issue, expanded: the lifecycle timeline from `activity_events`, and the
 * delivery command for its subject when one can honestly be stated. A
 * finding issue has nothing to deliver — its detail is the per-cluster
 * remaining count `listIssues` already computes.
 */
export interface IssueDetail {
    issue: IssueListItem;
    events: ActivityEvent[];
    /** `helm upgrade --version …` for a release issue with a target. */
    command: string | null;
}

export async function issueDetail(orgId: string, id: string): Promise<IssueDetail> {
    const items = await listIssues(orgId);
    const issue = items.find((i) => i.id === id);
    if (!issue) throw new AppError(404, "Issue not found");

    const events = await remediationRepository.listEventsForIssue(id, orgId);

    let command: string | null = null;
    if (issue.scope === "release" && issue.chartName != null && issue.toChartVersion != null) {
        const release =
            issue.releaseId != null ? await helmReleaseRepository.findById(issue.releaseId) : null;
        if (release) {
            command = buildReleaseUpgradeCommand(
                {
                    name: release.name,
                    namespace: release.namespace,
                    chartName: release.chartName,
                    chartVersion: release.chartVersion,
                },
                issue.toChartVersion
            );
        }
    }

    return { issue, events, command };
}

/**
 * The inventory verify loop: called after a cluster's inventory report lands.
 * An applied image issue verifies when the digest it moves away from is no
 * longer running in the cluster — the report is a full set replacement, so
 * the first report after the deploy answers it. A release issue verifies
 * when the release's recorded chart version has moved off the one the issue
 * started from.
 *
 * Best-effort by contract: a failure here must never fail the inventory
 * ingest that triggered it.
 */
export async function verifyAppliedIssues(clusterId: string): Promise<number> {
    let verified = 0;
    try {
        const flip = async (issue: Issue) => {
            const updated = await remediationRepository.updateIssue(issue.id, issue.orgId, {
                state: "verified",
                verifiedAt: new Date(),
            });
            if (updated) {
                verified += 1;
                await emitIssueEvent("issue.verified", updated);
            }
        };

        const imageIssues = await remediationRepository.findAppliedImageIssues(clusterId);
        for (const { issue, fromDigestStillRunning } of imageIssues) {
            if (!fromDigestStillRunning) await flip(issue);
        }

        const releaseIssues = await remediationRepository.findAppliedReleaseIssues(clusterId);
        for (const { issue, currentChartVersion } of releaseIssues) {
            // Verified only on positive evidence: the release still exists,
            // its version is known, and it is no longer the one the issue
            // moved away from. Absence of the release proves nothing.
            if (
                currentChartVersion != null &&
                issue.fromChartVersion != null &&
                currentChartVersion !== issue.fromChartVersion
            ) {
                await flip(issue);
            }
        }
    } catch (error) {
        log.error({ error, clusterId }, "Inventory verify sweep failed");
    }
    return verified;
}

/**
 * The scan verify loop — the second sweep site, same contract: only the
 * system writes `verified`. A finding issue verifies when no counted finding
 * with its identity remains anywhere in the org. The inventory sweep cannot
 * see this (it watches digests, not findings), so this runs where finding
 * sets change: after a scan run completes.
 *
 * Org-wide on purpose: the finding may disappear from the cluster the user
 * cared about while persisting in another, and such an issue correctly stays
 * open — the detail's per-cluster count is what makes that read as correct
 * rather than stuck.
 *
 * Best-effort by contract, like the inventory sweep.
 */
export async function verifyFindingIssues(orgId: string): Promise<number> {
    let verified = 0;
    try {
        const inFlight = await remediationRepository.findInFlightFindingIssues(orgId);
        if (inFlight.length === 0) return 0;

        const status = await remediationRepository.findingIssueStatus(
            orgId,
            inFlight.map((i) => ({
                packageType: i.packageType!,
                packageName: i.packageName!,
                vulnIdentity: i.vulnIdentity!,
            }))
        );

        // Only the issues the exact key calls fixed pay for the alias check.
        const unmatched = inFlight.filter((i) => !status.has(findingIssueKey(i)));
        const stillNamed = await remediationRepository.findingIssuesStillNamed(orgId, unmatched);

        for (const issue of unmatched) {
            // Still counted under a record that names the issue's advisory: the
            // identity is mid-move, not fixed (see `findingIssuesStillNamed`).
            if (stillNamed.has(issue.id)) continue;
            const updated = await remediationRepository.updateIssue(issue.id, issue.orgId, {
                state: "verified",
                verifiedAt: new Date(),
            });
            if (updated) {
                verified += 1;
                await emitIssueEvent("issue.verified", updated);
            }
        }
    } catch (error) {
        log.error({ error, orgId }, "Finding verify sweep failed");
    }
    return verified;
}

/**
 * The `fix.available` consumer — issues-workflow.md phase 3. Called by the
 * OSV sync at the point where it has committed advisory updates that *gained*
 * a fixed version (none → some, so re-syncs cannot double-fire). An in-flight
 * finding issue matching the advisory's collapsed identity is exactly the
 * someone remediation-workflow.md phase 5 left this event without.
 *
 * Best-effort: a bookkeeping failure must never fail the sync that saw the
 * fix land.
 */
export async function notifyFixAvailable(gainedVulnerabilityIds: string[]): Promise<number> {
    let emitted = 0;
    try {
        if (gainedVulnerabilityIds.length === 0) return 0;

        const advisories = await remediationRepository.resolveIdentitiesByVulnerabilityIds(
            gainedVulnerabilityIds
        );
        if (advisories.length === 0) return 0;
        const advisoryByIdentity = new Map(advisories.map((a) => [a.identity, a]));

        const issues = await remediationRepository.findInFlightFindingIssuesByIdentities(
            advisories.map((a) => a.identity)
        );

        for (const issue of issues) {
            const advisory = advisoryByIdentity.get(issue.vulnIdentity!);
            await remediationRepository.appendEvent({
                orgId: issue.orgId,
                clusterId: null,
                type: "issue.fix-available",
                issueId: issue.id,
                payload: {
                    scope: "finding",
                    vulnId: issue.vulnId,
                    packageName: issue.packageName,
                    packageType: issue.packageType,
                    advisoryVulnId: advisory?.vulnId ?? null,
                },
            });
            emitted += 1;
        }
    } catch (error) {
        log.error({ error }, "Failed to emit issue.fix-available events");
    }
    return emitted;
}

async function emitIssueEvent(type: ActivityEventType, issue: Issue): Promise<void> {
    try {
        await remediationRepository.appendEvent({
            orgId: issue.orgId,
            clusterId: issue.clusterId,
            type,
            imageId: issue.imageId,
            issueId: issue.id,
            payload: {
                scope: issue.scope,
                repository: issue.repository,
                fromTag: issue.fromTag,
                toTag: issue.toTag,
                fromDigest: issue.fromDigest,
                toDigest: issue.toDigest,
                chartName: issue.chartName,
                fromChartVersion: issue.fromChartVersion,
                toChartVersion: issue.toChartVersion,
                vulnId: issue.vulnId,
                packageName: issue.packageName,
                packageType: issue.packageType,
                closedReason: issue.closedReason,
                by: issue.state === "closed" ? issue.closedByEmail : issue.createdByEmail,
            },
        });
    } catch (error) {
        log.error({ error, issueId: issue.id, type }, "Failed to append activity event");
    }
}

// ---------------------------------------------------------------------------
// Suppression — finding_states
// ---------------------------------------------------------------------------

export interface SuppressFindingInput {
    kind: "suppressed" | "accepted-risk";
    vulnId: string;
    packageType: string;
    packageName: string;
    reason: string;
    expiresAt: Date;
}

/**
 * Suppress or accept-risk one finding, org-wide, until `expiresAt`. Owner,
 * reason and expiry are all mandatory — enforced by the schema, restated by
 * the zod layer — and nothing calls this from a worker: suppression is never
 * automatic.
 */
export async function suppressFinding(orgId: string, actor: Actor, input: SuppressFindingInput) {
    if (input.expiresAt.getTime() <= Date.now()) {
        throw new AppError(400, "expiresAt must be in the future");
    }

    const identity = await remediationRepository.resolveVulnIdentity(input.vulnId);
    if (!identity) throw new AppError(404, `Advisory ${input.vulnId} not found`);

    const state = await remediationRepository.upsertFindingState({
        orgId,
        kind: input.kind,
        packageType: input.packageType,
        packageName: input.packageName,
        vulnIdentity: identity,
        vulnId: input.vulnId,
        createdByUserId: actor.userId,
        createdByEmail: actor.email,
        reason: input.reason,
        expiresAt: input.expiresAt,
    });

    try {
        await remediationRepository.appendEvent({
            orgId,
            type: "finding.suppressed",
            payload: {
                kind: input.kind,
                vulnId: input.vulnId,
                packageName: input.packageName,
                packageType: input.packageType,
                reason: input.reason,
                expiresAt: input.expiresAt.toISOString(),
                by: actor.email,
            },
        });
    } catch (error) {
        log.error({ error, orgId, vulnId: input.vulnId }, "Failed to append suppression event");
    }

    return state;
}

export async function removeFindingState(orgId: string, actor: Actor, id: string) {
    const removed = await remediationRepository.deleteFindingState(id, orgId);
    if (!removed) throw new AppError(404, "Suppression not found");

    try {
        await remediationRepository.appendEvent({
            orgId,
            type: "finding.unsuppressed",
            payload: {
                vulnId: removed.vulnId,
                packageName: removed.packageName,
                packageType: removed.packageType,
                by: actor.email,
            },
        });
    } catch (error) {
        log.error({ error, orgId, id }, "Failed to append unsuppression event");
    }

    return removed;
}
