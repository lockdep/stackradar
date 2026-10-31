/**
 * From findings to fixes — the Fixes list.
 *
 * The unit of remediation is an image: forty workloads running six distinct
 * images is six moves, not forty rows and not two thousand findings.
 * `remediation-rollup.service.ts` folds the org's findings into that per-image
 * rollup and `suggestion.service.ts` ranks it into the suggestion feed; this
 * module turns the feed into the one list `GET /api/remediation/fixes` serves,
 * attaches the base-image rebuilds, asks the public chart index to measure
 * the chart bumps nothing here could, and names the images it has no move for.
 *
 * Every row is a computed claim — recomputed at read time, never stored — and
 * nothing here is a write or implies a move is safe. The issue lifecycle and
 * suppression that once sat beside this list were removed with their routes;
 * their tables (`issues`, `finding_states`) stay for the deprecation window.
 */

import { remediationRepository } from "../repositories/remediation.repository.js";
import type { UpgradeAvailability } from "./upgrade-recommendation.service.js";
import {
    type ChartUpgradeSuggestion,
    type ImageSuggestion,
    type SuggestionCluster,
    type UnmeasuredChartSuggestion,
} from "./suggestion.service.js";
import type { VersionBump } from "../lib/image-tags.js";
import { moveScope, type ScopeCounts } from "../db/finding-delta.js";
import type { ImageControl } from "../lib/image-control.js";
import { chartIndexConfigured, chartIndexDelta } from "../lib/chart-index-client.js";
import { baseUpgradesForOrg, type BaseUpgradeRecommendation } from "./base-upgrade.service.js";
import { createLogger } from "../lib/logger.js";
import { fixRollupForOrg, type EolLine, type FixRow } from "./remediation-rollup.service.js";

const log = createLogger("remediation");

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
    /** Risk Score contribution the move removes — the rank key; null when unmeasured. */
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
        delivery:
            best.kind === "same-tag" ? "rebuild the image — no Dockerfile change" : "change the FROM line and rebuild",
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
    asks: Array<{ fix: FixListItem; repoUrl: string; chart: string; from: string; to: string }>,
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
            }),
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
        release: s.pinnedBy ? { name: s.pinnedBy.releaseName, namespace: s.pinnedBy.releaseNamespace } : null,
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
    controlByImage: ReadonlyMap<string, ImageControl>,
): EffectiveControl {
    if (release.attributedRepoUrl) return "third-party";
    if (imageIds.length === 0) return "built";
    return imageIds.every((id) => controlByImage.get(id) === "third-party") ? "third-party" : "built";
}

function chartFix(
    s: ChartUpgradeSuggestion,
    spreadByImage: Map<string, { workloads: number; containers: number }>,
    controlByImage: ReadonlyMap<string, ImageControl>,
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
        { findings: 0, kev: 0, high: 0, introduced: 0, byScope: { application: 0, base: 0 } },
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
        control: chartControl(
            s.release,
            s.imageMoves.map((m) => m.fromImageId),
            controlByImage,
        ),
        scope: moveScope(cleared.byScope),
        cleared,
        riskRemoved: s.riskRemoved,
        upperBound: null,
        // A workload running two of the moved images is counted once per
        // image here — the sum is "places the bump lands", not a distinct count.
        workloads: s.imageMoves.reduce((n, m) => n + (spreadByImage.get(m.fromImageId)?.workloads ?? 0), 0),
        containers: s.imageMoves.reduce((n, m) => n + (spreadByImage.get(m.fromImageId)?.containers ?? 0), 0),
        images: s.imageMoves.length,
        delivery: s.delivery ? `${s.delivery.tool} app ${s.delivery.appName}` : s.command ? "helm upgrade" : null,
        target: { type: "release", releaseId: s.release.id },
    };
}

function unmeasuredChartFix(
    s: UnmeasuredChartSuggestion,
    workloadsByRelease: Map<string, { workloads: number; containers: number; images: number }>,
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
        rollup.rows.map((r) => [r.image.id, { workloads: r.workloadCount, containers: r.containerCount }]),
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
                    askIndex.push({
                        fix,
                        repoUrl,
                        chart: s.release.chartName,
                        from: s.release.chartVersion,
                        to: s.targetVersion,
                    });
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
    const baseUpgrades = await baseUpgradesForOrg(
        orgId,
        rebuildable.map((r) => r.image.id),
    ).catch((error: unknown) => {
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
