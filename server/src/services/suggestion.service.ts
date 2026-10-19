/**
 * The suggestion feed behind the Fixes page and the remediation panels on
 * the image and release pages.
 *
 * The row is a **suggestion, not an image**: a typed, cluster-scoped, ranked
 * claim about one move. Forty risky images might reduce to six moves — three
 * chart bumps, two tag overrides, one base-image migration — and the feed
 * says so, highest impact first.
 *
 * ## Two classes, never blended
 *
 * - **Measured** suggestions come from SBOMs we already hold. They may state
 *   what an upgrade removes, because both sides were scanned.
 * - **Unmeasured** suggestions come from repository metadata — a sibling
 *   release at a newer chart version whose images nobody scanned, or a chart
 *   repository's `index.yaml`. They may say *a newer chart exists* and
 *   nothing more, and they rank below every measured suggestion. The copy is
 *   "could address up to", never "will".
 *
 * EOL advisories are the third band: the largest work with the least
 * prescribable move, so they rank last.
 *
 * Suggestions are computed at read time and never stored. "Track this move"
 * creates a `remediation_actions` row through the existing lifecycle; the
 * feed is where actions come from.
 */

import { remediationRepository } from "../repositories/remediation.repository.js";
import { chartRepositoryRepository } from "../repositories/chart-repository.repository.js";
import {
    chartAttributionRepository,
    type ChartAttributionForOrg,
} from "../repositories/chart-attribution.repository.js";
import { clusterRepository } from "../repositories/cluster.repository.js";
import { isChartDeprecated } from "../lib/chart-attribution.js";
import { kubeCompatibility } from "../lib/kube-constraint.js";
import {
    recommendForRelease,
    type ChartEvidence,
    type ChartMatchKind,
    type ChartUpgradeRecommendation,
    type ImageUpgradeRecommendation,
    type TagCandidate,
} from "./upgrade-recommendation.service.js";
import { comparableFindings, type ComparableFinding } from "../db/finding-delta.js";
import { compare, schemeForPurlType } from "../matching/index.js";
import { buildReleaseUpgradeCommand, buildValuesOverride, type ValuesOverride } from "../lib/remediation-commands.js";
import { bestNewerTag, bumpKind, type VersionBump } from "../lib/image-tags.js";
import { createLogger } from "../lib/logger.js";
import type { EolLine, FixRow } from "./remediation-rollup.service.js";

const log = createLogger("suggestions");

export type SuggestionType =
    "chart-upgrade" | "image-tag-upgrade" | "image-override" | "chart-newer-unmeasured" | "eol-migration";

export interface SuggestionCluster {
    id: string;
    name: string | null;
}

interface SuggestionBase {
    /** Stable synthetic id — `<kind>:<subject>` — for expansion state. */
    id: string;
    type: SuggestionType;
    /** The class split. Load-bearing: unmeasured must render as weaker. */
    measured: boolean;
    cluster: SuggestionCluster;
    /**
     * Positive = risk the move removes (`-summary.riskChange`). Null for
     * anything that cannot claim a number.
     */
    riskRemoved: number | null;
    clearsKev: boolean;
}

export interface SuggestionRelease {
    id: string;
    name: string;
    namespace: string;
    chartName: string | null;
    chartVersion: string | null;
    /**
     * From `app.kubernetes.io/version` — context for the app-version-move
     * line, never evidence (the schema forbids deriving anything from it).
     */
    appVersion: string | null;
    repoUrl: string | null;
    /** The attributed repo when `repoUrl` is null and the nightly pass matched one. */
    attributedRepoUrl: string | null;
    /**
     * The chart reads as deprecated in its Artifact Hub package. Claimed only
     * via an attribution (or an observed repo that agrees with it) — never a
     * name-only guess.
     */
    chartDeprecated: boolean;
}

export interface ImageSuggestion extends SuggestionBase {
    type: "image-tag-upgrade" | "image-override";
    measured: true;
    image: { id: string; digest: string; repository: string | null; currentTag: string | null };
    best: TagCandidate;
    workloadCount: number;
    containerCount: number;
    /** The chart that pins the image, when one does — the override shape. */
    pinnedBy: {
        releaseId: string;
        releaseName: string;
        releaseNamespace: string;
        chartName: string | null;
    } | null;
    /** The GitOps app that delivers it, when one does — where the fix lands. */
    deliveredBy: { tool: string; appName: string } | null;
    /** Only on `image-override`: the values snippet and its honest caveat. */
    override: ValuesOverride | null;
}

export interface ChartUpgradeSuggestion extends SuggestionBase {
    type: "chart-upgrade";
    measured: true;
    release: SuggestionRelease;
    /**
     * A sibling target names the release running it; a platform-render target
     * has no release anywhere, so `releaseId`, `cluster` and `namespace` are
     * null and the version was measured from the chart's own tarball.
     */
    target: {
        releaseId: string | null;
        chartVersion: string;
        cluster: string | null;
        namespace: string | null;
    };
    /**
     * What backs the measurement. `platform-render` copy must say the
     * numbers come from the chart's **default configuration** — the honest
     * limit of a values-free render.
     */
    evidence: ChartEvidence;
    bump: VersionBump;
    matchKind: ChartMatchKind;
    imageMoves: ChartUpgradeRecommendation["imageMoves"];
    unmeasuredImages: number;
    delivery: { tool: string; appName: string; targetRevision: string | null } | null;
    /** `helm upgrade --version …` when no GitOps tool delivers the release. */
    command: string | null;
    /** The target's `kubeVersion` constraint excludes this cluster. Silence when unknown. */
    kubeWarning: { clusterVersion: string; kubeRange: string } | null;
    /**
     * Image suggestions this chart bump subsumes — collapsed out of the feed
     * but carried here in full, so a tag override that is deliverable today
     * is never hidden behind the bump that would also cover it.
     */
    subsumes: ImageSuggestion[];
}

export interface UnmeasuredChartSuggestion extends SuggestionBase {
    type: "chart-newer-unmeasured";
    measured: false;
    riskRemoved: null;
    release: SuggestionRelease;
    targetVersion: string;
    bump: VersionBump;
    matchKind: ChartMatchKind;
    /**
     * Where the version came from. No source measured anything;
     * `artifact-hub-mirror` additionally means nobody fetched the
     * repository's own index — the hub's listing is the only evidence.
     */
    source: "sibling-release" | "chart-repository" | "artifact-hub-mirror";
    /**
     * Σ risk of currently-fixable findings on the release's images — an upper
     * bound on what the bump *could* address, and the copy must say "up to".
     */
    upperBoundRisk: number;
    fixableFindings: number;
    /**
     * "Chart 58.7 → 61.2 moves the packaged application v2.51 → v2.54" —
     * strictly more informative than a bare chart version and claims nothing
     * about vulnerabilities. `appVersion` stays context, never evidence: the
     * line renders as description, not as a delta. Null unless both sides are
     * known and differ.
     */
    appVersionMove: { from: string; to: string } | null;
    /**
     * The tightened upper bound where the finding is on the application
     * itself: findings whose matched package version equals the release's
     * current `appVersion` and whose `fixed_version` is at or below the
     * candidate's app version (same comparator family as the matcher).
     * Still rendered in the unmeasured class — "could", never "will". Null
     * when the app-version move is unknown.
     */
    fixesAtCandidateAppVersion: number | null;
    /** The target's `kubeVersion` constraint excludes this cluster. Silence when unknown. */
    kubeWarning: { clusterVersion: string; kubeRange: string } | null;
}

export interface EolSuggestion extends SuggestionBase {
    type: "eol-migration";
    measured: false;
    riskRemoved: null;
    image: { id: string; digest: string; repository: string | null; currentTag: string | null };
    lines: EolLine[];
    findings: number;
    /** Σ risk of the EOL findings — the impact band it ranks within. */
    impact: number;
}

export type Suggestion = ChartUpgradeSuggestion | ImageSuggestion | UnmeasuredChartSuggestion | EolSuggestion;

/**
 * Ceiling on the release-axis fan-out. Each release costs a recommendation
 * query with several finding diffs; releases are examined in risk order so
 * the cap trims the tail, and trimming is logged, never silent.
 */
const MAX_RELEASES_EXAMINED = 50;

// ---------------------------------------------------------------------------
// Ranking and collapse — pure, exported for the unit test
// ---------------------------------------------------------------------------

/**
 * The feed's order, as a sortable key. Three bands:
 *
 *  0. measured — KEV-clearing first, then by risk removed;
 *  1. unmeasured newer-chart — by the "could address up to" upper bound;
 *  2. EOL advisories — by the risk of the findings stranded on the EOL line.
 *
 * An unmeasured suggestion can never outrank a measured one: the band is the
 * leading component, and nothing else can override it.
 */
export function rankKey(s: Suggestion): [number, number, number] {
    if (s.type === "chart-newer-unmeasured") return [1, 0, -s.upperBoundRisk];
    if (s.type === "eol-migration") return [2, 0, -s.impact];
    return [0, s.clearsKev ? 0 : 1, -(s.riskRemoved ?? 0)];
}

/**
 * Collapse subsumed image suggestions into their chart bump, then rank.
 *
 * The collapse only ever folds into a **measured** chart suggestion — an
 * unmeasured "newer chart exists" must not swallow a tag override that is
 * deliverable today — and the folded suggestion is kept whole inside
 * `subsumes`, not discarded.
 */
export function assembleSuggestions(parts: {
    imageSuggestions: ImageSuggestion[];
    chartSuggestions: ChartUpgradeSuggestion[];
    unmeasured: UnmeasuredChartSuggestion[];
    eol: EolSuggestion[];
}): Suggestion[] {
    const subsumedBy = new Map<string, ChartUpgradeSuggestion>();
    for (const chart of parts.chartSuggestions) {
        for (const move of chart.imageMoves) {
            if (!subsumedBy.has(move.fromImageId)) subsumedBy.set(move.fromImageId, chart);
        }
    }

    const standalone: ImageSuggestion[] = [];
    for (const img of parts.imageSuggestions) {
        const chart = subsumedBy.get(img.image.id);
        if (chart) chart.subsumes.push(img);
        else standalone.push(img);
    }

    const all: Suggestion[] = [...parts.chartSuggestions, ...standalone, ...parts.unmeasured, ...parts.eol];

    return all.sort((a, b) => {
        const ka = rankKey(a);
        const kb = rankKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
    });
}

const stripV = (v: string): string => v.replace(/^v/i, "");

/**
 * The phase-1 tightened upper bound, pure and exported for the unit test.
 *
 * `component_vulnerabilities.fixed_version` is per *package*, so comparing it
 * to a chart's `appVersion` is category confusion in general. The one honest
 * case: findings whose matched package version **equals** the release's
 * current `appVersion` — the application binary itself, not a library inside
 * it. For those, `fixed_version <= candidate appVersion` (the matcher's own
 * comparator family, strict, refusal on `null`) supports "N findings have
 * fixes released at or below the candidate's app version". Counted on the
 * cross-image finding key so one advisory on two images is one finding.
 */
/** Both sides known and different, or nothing — an equal move is no line. */
function appVersionMove(from: string | null, to: string | null): { from: string; to: string } | null {
    if (!from || !to) return null;
    return stripV(from) === stripV(to) ? null : { from, to };
}

export function countFixesAtCandidateAppVersion(
    findings: ComparableFinding[],
    move: { from: string; to: string },
): number {
    const from = stripV(move.from);
    const to = stripV(move.to);
    const counted = new Set<string>();
    for (const f of findings) {
        if (counted.has(f.key)) continue;
        if (!f.packageVersion || !f.fixedVersion) continue;
        if (stripV(f.packageVersion) !== from) continue;
        const scheme = schemeForPurlType(f.purlType);
        if (!scheme) continue;
        const cmp = compare(stripV(f.fixedVersion), to, scheme, { strict: true });
        if (cmp && cmp.cmp <= 0) counted.add(f.key);
    }
    return counted.size;
}

// ---------------------------------------------------------------------------
// Assembly from live data
// ---------------------------------------------------------------------------

export interface SuggestionInputs {
    orgId: string;
    /** Already cluster-filtered when the caller scoped the feed. */
    rows: FixRow[];
    /** Org-wide measured image recommendations — the rollup's available moves, best first. */
    upgrades: ImageUpgradeRecommendation[];
    /** Σ risk of fixable / EOL findings per image, from the rollup fold. */
    riskSums: Map<string, { fixableRiskSum: number; eolRiskSum: number }>;
}

export async function buildSuggestionsForOrg(input: SuggestionInputs): Promise<Suggestion[]> {
    const { orgId, rows, upgrades, riskSums } = input;

    const rowByImage = new Map(rows.map((r) => [r.image.id, r]));
    const imageIds = [...rowByImage.keys()];

    // Everything the builders share is fetched once, here, and passed down —
    // no builder issues its own copy of these reads.
    const [releaseRows, deliveryRows, chartEntries, attributions, kubeVersions] = await Promise.all([
        remediationRepository.releasesForImages(orgId, imageIds),
        remediationRepository.deliveryContextForImages(
            orgId,
            upgrades.map((u) => u.current.imageId).filter((id) => rowByImage.has(id)),
        ),
        chartRepositoryRepository.entriesForOrg(orgId),
        chartAttributionRepository.forOrg(orgId),
        clusterRepository.kubernetesVersionsForOrg(orgId),
    ]);

    const attributionByChart: AttributionByChart = new Map(attributions.map((a) => [a.chartName, a]));

    const deliveryByImage = foldDeliveryContext(deliveryRows);

    const imageSuggestions = buildImageSuggestions(upgrades, rowByImage, deliveryByImage);

    const releaseGroups = groupReleases(releaseRows, attributionByChart);
    const recommendations = await releaseAxisRecommendations(orgId, rows, releaseGroups);

    const { chartSuggestions, claimedVersion } = buildChartUpgradeSuggestions(recommendations, releaseGroups);

    const unmeasured = await buildUnmeasuredChartSuggestions({
        recommendations,
        releaseGroups,
        claimedVersion,
        chartEntries,
        attributionByChart,
        kubeVersions,
        riskSums,
        rowByImage,
    });

    const eol = buildEolSuggestions(rows, riskSums);

    return assembleSuggestions({ imageSuggestions, chartSuggestions, unmeasured, eol });
}

// ---------------------------------------------------------------------------
// Builders — one per suggestion shape, over data the orchestrator fetched once
// ---------------------------------------------------------------------------

type ReleaseRows = Awaited<ReturnType<typeof remediationRepository.releasesForImages>>;
type DeliveryRows = Awaited<ReturnType<typeof remediationRepository.deliveryContextForImages>>;
type ChartEntries = Awaited<ReturnType<typeof chartRepositoryRepository.entriesForOrg>>;
type KubeVersions = Awaited<ReturnType<typeof clusterRepository.kubernetesVersionsForOrg>>;
type AttributionByChart = Map<string, ChartAttributionForOrg>;
type ReleaseRecommendations = Array<{ releaseId: string; rec: ChartUpgradeRecommendation }>;

interface DeliveryContext {
    release: {
        releaseId: string;
        releaseName: string;
        releaseNamespace: string;
        chartName: string | null;
    } | null;
    application: { tool: string; appName: string } | null;
}

/** Fold delivery context per image — the first release and first application win. */
function foldDeliveryContext(deliveryRows: DeliveryRows): Map<string, DeliveryContext> {
    const deliveryByImage = new Map<string, DeliveryContext>();
    for (const d of deliveryRows) {
        const ctx = deliveryByImage.get(d.imageId) ?? { release: null, application: null };
        if (d.releaseId != null && ctx.release == null) {
            ctx.release = {
                releaseId: d.releaseId,
                releaseName: d.releaseName!,
                releaseNamespace: d.releaseNamespace!,
                chartName: d.releaseChartName,
            };
        }
        if (d.applicationTool != null && ctx.application == null) {
            ctx.application = { tool: d.applicationTool, appName: d.applicationName! };
        }
        deliveryByImage.set(d.imageId, ctx);
    }
    return deliveryByImage;
}

/**
 * The image-axis suggestions: `image-tag-upgrade`, or `image-override` when a
 * chart pins the image — one loop because the two are one shape and the type
 * is decided per row by whether a release delivers it.
 */
function buildImageSuggestions(
    upgrades: ImageUpgradeRecommendation[],
    rowByImage: Map<string, FixRow>,
    deliveryByImage: Map<string, DeliveryContext>,
): ImageSuggestion[] {
    const imageSuggestions: ImageSuggestion[] = [];
    for (const rec of upgrades) {
        const row = rowByImage.get(rec.current.imageId);
        if (!row || !rec.best) continue;

        const ctx = deliveryByImage.get(rec.current.imageId);
        const pinned = ctx?.release ?? null;
        const type: ImageSuggestion["type"] = pinned ? "image-override" : "image-tag-upgrade";

        imageSuggestions.push({
            id: `${type === "image-override" ? "override" : "tag"}:${row.image.id}`,
            type,
            measured: true,
            cluster: { id: row.image.clusterId, name: row.image.clusterName },
            riskRemoved: -rec.best.summary.riskChange,
            clearsKev: rec.best.summary.resolvedKev > 0,
            image: {
                id: row.image.id,
                digest: row.image.digest,
                repository: row.image.repository,
                currentTag: rec.current.tag,
            },
            best: rec.best,
            workloadCount: row.workloadCount,
            containerCount: row.containerCount,
            pinnedBy: pinned,
            deliveredBy: ctx?.application ?? null,
            override: pinned
                ? buildValuesOverride({
                      repository: row.image.repository,
                      targetTag: rec.best.tag,
                  })
                : null,
        });
    }
    return imageSuggestions;
}

interface ReleaseGroup {
    release: SuggestionRelease;
    cluster: SuggestionCluster;
    imageIds: Set<string>;
}

/** One group per release the counted images belong to, keyed by release id. */
function groupReleases(releaseRows: ReleaseRows, attributionByChart: AttributionByChart): Map<string, ReleaseGroup> {
    const releaseGroups = new Map<string, ReleaseGroup>();
    for (const r of releaseRows) {
        let group = releaseGroups.get(r.releaseId);
        if (!group) {
            const attribution = r.chartName ? attributionByChart.get(r.chartName) : undefined;
            // The attribution may only speak for this release when the scanner
            // observed no repo, or observed the same one the evidence points at.
            const applicable =
                attribution && (r.repoUrl === null || r.repoUrl === attribution.repoUrl) ? attribution : undefined;
            group = {
                release: {
                    id: r.releaseId,
                    name: r.name,
                    namespace: r.namespace,
                    chartName: r.chartName,
                    chartVersion: r.chartVersion,
                    appVersion: r.appVersion,
                    repoUrl: r.repoUrl,
                    attributedRepoUrl: r.repoUrl === null ? (applicable?.repoUrl ?? null) : null,
                    chartDeprecated: applicable ? isChartDeprecated(applicable, r.chartVersion) : false,
                },
                cluster: { id: r.clusterId, name: r.clusterName },
                imageIds: new Set(),
            };
            releaseGroups.set(r.releaseId, group);
        }
        group.imageIds.add(r.imageId);
    }
    return releaseGroups;
}

/**
 * The release-axis fan-out. Examine highest-risk releases first, so the cap
 * trims the tail: `rows` is risk-ranked, so the first row referencing a
 * release sets its order.
 */
async function releaseAxisRecommendations(
    orgId: string,
    rows: FixRow[],
    releaseGroups: Map<string, ReleaseGroup>,
): Promise<ReleaseRecommendations> {
    const releasesByImage = new Map<string, string[]>();
    for (const [releaseId, group] of releaseGroups) {
        for (const imageId of group.imageIds) {
            const list = releasesByImage.get(imageId);
            if (list) list.push(releaseId);
            else releasesByImage.set(imageId, [releaseId]);
        }
    }
    const releaseOrder: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        for (const releaseId of releasesByImage.get(row.image.id) ?? []) {
            if (!seen.has(releaseId)) {
                seen.add(releaseId);
                releaseOrder.push(releaseId);
            }
        }
    }

    const examined = releaseOrder.slice(0, MAX_RELEASES_EXAMINED);
    if (releaseOrder.length > examined.length) {
        log.warn(
            { orgId, releases: releaseOrder.length, examined: examined.length },
            "Truncated release-axis suggestion scan",
        );
    }

    return Promise.all(
        examined.map(async (releaseId) => ({
            releaseId,
            rec: await recommendForRelease(orgId, releaseId),
        })),
    );
}

/**
 * Measured chart bumps — the releases whose recommendation came back
 * `available`. Also starts the claimed-version map: the best chart version
 * each release's suggestion already covers, which the unmeasured builder
 * extends with its sibling claims and consults before adding a repository
 * version — a version no newer than what is claimed adds nothing.
 */
function buildChartUpgradeSuggestions(
    recommendations: ReleaseRecommendations,
    releaseGroups: Map<string, ReleaseGroup>,
): { chartSuggestions: ChartUpgradeSuggestion[]; claimedVersion: Map<string, string> } {
    const chartSuggestions: ChartUpgradeSuggestion[] = [];
    const claimedVersion = new Map<string, string>();

    for (const { releaseId, rec } of recommendations) {
        const group = releaseGroups.get(releaseId);
        if (!group) continue;
        if (rec.availability !== "available" || !rec.target) continue;

        const riskRemoved = -rec.imageMoves.reduce((n, m) => n + m.summary.riskChange, 0);
        chartSuggestions.push({
            id: `chart:${releaseId}`,
            type: "chart-upgrade",
            measured: true,
            cluster: group.cluster,
            riskRemoved: Math.round(riskRemoved * 10) / 10,
            clearsKev: rec.imageMoves.some((m) => m.summary.resolvedKev > 0),
            release: group.release,
            target: rec.target,
            evidence: rec.evidence ?? "sibling-release",
            bump: rec.bump,
            matchKind: rec.matchKind ?? "chart-name",
            imageMoves: rec.imageMoves,
            unmeasuredImages: rec.unmeasuredImages,
            delivery: rec.delivery,
            command:
                rec.delivery == null
                    ? buildReleaseUpgradeCommand(
                          {
                              name: group.release.name,
                              namespace: group.release.namespace,
                              chartName: group.release.chartName,
                              chartVersion: group.release.chartVersion,
                          },
                          rec.target.chartVersion,
                      )
                    : null,
            kubeWarning: rec.kubeWarning,
            subsumes: [],
        });
        claimedVersion.set(releaseId, rec.target.chartVersion);
    }

    return { chartSuggestions, claimedVersion };
}

/** Σ risk / count of currently-fixable findings across a release's images. */
function upperBoundFor(
    group: ReleaseGroup,
    riskSums: SuggestionInputs["riskSums"],
    rowByImage: Map<string, FixRow>,
): { risk: number; findings: number } {
    let risk = 0;
    let findings = 0;
    for (const imageId of group.imageIds) {
        risk += riskSums.get(imageId)?.fixableRiskSum ?? 0;
        findings += rowByImage.get(imageId)?.findings.fixable ?? 0;
    }
    return { risk: Math.round(risk * 10) / 10, findings };
}

/**
 * The target version's `kubeVersion` constraint vs the cluster, resolved
 * through the mirror — the only source of ranges. `excluded` with both
 * sides known, or nothing; every unknown renders as silence.
 */
function kubeWarningFor(
    release: SuggestionRelease,
    clusterId: string,
    targetVersion: string,
    attributionByChart: AttributionByChart,
    kubeVersions: KubeVersions,
): { clusterVersion: string; kubeRange: string } | null {
    if (!release.chartName) return null;
    const attribution = attributionByChart.get(release.chartName);
    if (!attribution || (release.repoUrl !== null && release.repoUrl !== attribution.repoUrl)) {
        return null;
    }
    const kubeRange = attribution.versions.find((v) => v.pkg === targetVersion)?.kube ?? null;
    const clusterVersion = kubeVersions.get(clusterId) ?? null;
    return clusterVersion && kubeRange && kubeCompatibility(clusterVersion, kubeRange) === "excluded"
        ? { clusterVersion, kubeRange }
        : null;
}

interface UnmeasuredBuildInputs {
    recommendations: ReleaseRecommendations;
    releaseGroups: Map<string, ReleaseGroup>;
    /**
     * Versions the measured pass already claimed. The sibling-sourced claims
     * are added here too, so the repository scan below sees both.
     */
    claimedVersion: Map<string, string>;
    chartEntries: ChartEntries;
    attributionByChart: AttributionByChart;
    kubeVersions: KubeVersions;
    riskSums: SuggestionInputs["riskSums"];
    rowByImage: Map<string, FixRow>;
}

/**
 * The unmeasured `chart-newer-unmeasured` band, from its three sources in
 * precedence order: a sibling release the scan could not measure, then the
 * cached chart-repository indexes, then the Artifact Hub mirror. Ends with
 * the tightened bound — one batched
 * findings read for every suggestion whose app-version move is known.
 */
async function buildUnmeasuredChartSuggestions(input: UnmeasuredBuildInputs): Promise<UnmeasuredChartSuggestion[]> {
    const {
        recommendations,
        releaseGroups,
        claimedVersion,
        chartEntries,
        attributionByChart,
        kubeVersions,
        riskSums,
        rowByImage,
    } = input;

    const unmeasured: UnmeasuredChartSuggestion[] = [];

    // ----- sibling releases the scan could not measure ----------------------
    for (const { releaseId, rec } of recommendations) {
        const group = releaseGroups.get(releaseId);
        if (!group) continue;
        if (rec.availability !== "not-measured" || !rec.target) continue;

        const bound = upperBoundFor(group, riskSums, rowByImage);
        unmeasured.push({
            id: `newer:${releaseId}`,
            type: "chart-newer-unmeasured",
            measured: false,
            cluster: group.cluster,
            riskRemoved: null,
            clearsKev: false,
            release: group.release,
            targetVersion: rec.target.chartVersion,
            bump: rec.bump,
            matchKind: rec.matchKind ?? "chart-name",
            source: "sibling-release",
            upperBoundRisk: bound.risk,
            fixableFindings: bound.findings,
            appVersionMove: appVersionMove(rec.release.appVersion, rec.target.appVersion),
            fixesAtCandidateAppVersion: null,
            kubeWarning: rec.kubeWarning,
        });
        claimedVersion.set(releaseId, rec.target.chartVersion);
    }

    // ----- chart-repository awareness (phase 2) ----------------------------
    // `index.yaml` knows versions nobody in the org runs, and for attributed
    // charts whose repository has no cached entries yet (OCI, or an auto-added
    // repo the 04:45 index sync has not reached) the Artifact Hub mirror is
    // the fallback. Deliberately **not** gated on `chartEntries.length > 0` —
    // an org whose only repos are attributed-but-unsynced would otherwise
    // silently lose that fallback. A version only adds a suggestion when it is
    // newer than both the release's own and anything the sibling scan already
    // claimed — otherwise the existing suggestion covers it.
    {
        interface VersionWithApp {
            version: string;
            appVersion: string | null;
        }
        const byRepoAndChart = new Map<string, VersionWithApp[]>();
        const byChartName = new Map<string, VersionWithApp[]>();
        for (const entry of chartEntries) {
            const versions: VersionWithApp[] = entry.versions.map((v) => ({
                version: v.version,
                appVersion: v.appVersion,
            }));
            byRepoAndChart.set(`${entry.repoUrl}\u0000${entry.chartName}`, versions);
            const existing = byChartName.get(entry.chartName) ?? [];
            byChartName.set(entry.chartName, [...existing, ...versions]);
        }

        for (const [releaseId, group] of releaseGroups) {
            const { chartName, chartVersion, repoUrl, attributedRepoUrl } = group.release;
            if (!chartName || !chartVersion) continue;

            // Version-source precedence: entries of the release's own repo —
            // observed, or resolved through the attribution — beat name-only
            // entries, which beat the mirror's listing. Exact agreement on an
            // *observed* repo is a fact; through an attribution it is a
            // labelled inference — same rule `recommendForRelease` applies.
            const effectiveRepoUrl = repoUrl ?? attributedRepoUrl;
            const exact = effectiveRepoUrl ? byRepoAndChart.get(`${effectiveRepoUrl}\u0000${chartName}`) : undefined;
            const nameOnly = exact ?? byChartName.get(chartName);

            let versions: Array<{ version: string; appVersion: string | null }>;
            let matchKind: ChartMatchKind;
            let source: UnmeasuredChartSuggestion["source"];
            if (exact) {
                versions = exact;
                matchKind = repoUrl ? "repo-url" : "attributed";
                source = "chart-repository";
            } else if (nameOnly && nameOnly.length > 0) {
                versions = nameOnly;
                matchKind = "chart-name";
                source = "chart-repository";
            } else {
                // Mirror fallback: only through an attribution the release may
                // claim, and with deprecated versions skipped — a deprecated
                // listing is not a move to suggest.
                const attribution = attributionByChart.get(chartName);
                if (!attribution || (repoUrl !== null && repoUrl !== attribution.repoUrl)) {
                    continue;
                }
                versions = attribution.versions
                    .filter((v) => !v.deprecated)
                    .map((v) => ({ version: v.pkg, appVersion: v.app }));
                matchKind = "attributed";
                source = "artifact-hub-mirror";
            }
            if (versions.length === 0) continue;

            const { best } = bestNewerTag(
                chartVersion,
                versions.map((v) => v.version),
            );
            if (!best) continue;

            const claimed = claimedVersion.get(releaseId);
            if (claimed) {
                const cmp = bestNewerTag(claimed, [best]);
                if (!cmp.best) continue; // nothing newer than what is claimed
            }

            const existingIdx = unmeasured.findIndex((u) => u.release.id === releaseId);
            const bound = upperBoundFor(group, riskSums, rowByImage);
            const suggestion: UnmeasuredChartSuggestion = {
                id: `newer:${releaseId}`,
                type: "chart-newer-unmeasured",
                measured: false,
                cluster: group.cluster,
                riskRemoved: null,
                clearsKev: false,
                release: group.release,
                targetVersion: best,
                bump: bumpKind(chartVersion, best),
                matchKind,
                source,
                upperBoundRisk: bound.risk,
                fixableFindings: bound.findings,
                appVersionMove: appVersionMove(
                    group.release.appVersion,
                    versions.find((v) => v.version === best)?.appVersion ?? null,
                ),
                fixesAtCandidateAppVersion: null,
                kubeWarning: kubeWarningFor(group.release, group.cluster.id, best, attributionByChart, kubeVersions),
            };
            // A measured suggestion for the same release keeps its row; the
            // newer version here is additional, not a replacement.
            if (existingIdx >= 0) unmeasured[existingIdx] = suggestion;
            else unmeasured.push(suggestion);
        }
    }

    // ----- tightened bound ------------------------------------------------
    // One batched findings read for every unmeasured suggestion whose
    // app-version move is known, then the pure count per release.
    {
        const withMove = unmeasured.filter((u) => u.appVersionMove != null);
        if (withMove.length > 0) {
            const ids = new Set<string>();
            for (const u of withMove) {
                for (const imageId of releaseGroups.get(u.release.id)?.imageIds ?? []) {
                    ids.add(imageId);
                }
            }
            const findingSets = await comparableFindings([...ids]);
            for (const u of withMove) {
                const findings: ComparableFinding[] = [];
                for (const imageId of releaseGroups.get(u.release.id)?.imageIds ?? []) {
                    findings.push(...(findingSets.get(imageId) ?? []));
                }
                u.fixesAtCandidateAppVersion = countFixesAtCandidateAppVersion(findings, u.appVersionMove!);
            }
        }
    }

    return unmeasured;
}

/** EOL advisories — the largest work with the least prescribable move. */
function buildEolSuggestions(rows: FixRow[], riskSums: SuggestionInputs["riskSums"]): EolSuggestion[] {
    const eol: EolSuggestion[] = [];
    for (const row of rows) {
        if (row.findings.eol === 0) continue;
        eol.push({
            id: `eol:${row.image.id}`,
            type: "eol-migration",
            measured: false,
            cluster: { id: row.image.clusterId, name: row.image.clusterName },
            riskRemoved: null,
            clearsKev: false,
            image: {
                id: row.image.id,
                digest: row.image.digest,
                repository: row.image.repository,
                currentTag: row.image.tags[0] ?? null,
            },
            lines: row.eolLines,
            findings: row.findings.eol,
            impact: Math.round((riskSums.get(row.image.id)?.eolRiskSum ?? 0) * 10) / 10,
        });
    }
    return eol;
}
