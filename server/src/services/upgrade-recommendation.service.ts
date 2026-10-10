/**
 * "Which image tag should this workload move to, and what does that buy?"
 *
 * [base-image-recommendations.md](../../../docs/proposals/base-image-recommendations.md),
 * phases 1 and 2. Two axes over the same measurement:
 *
 * - **Image axis** — a newer tag of the same repository that this org has
 *   already scanned. Smallest blast radius, and the default.
 * - **Chart axis** — another release of the same chart at a newer version,
 *   whose image digests differ. The escalation, for when the chart pins the tag
 *   or one bump subsumes several.
 *
 * Phase 3 (provenance-free observation tables, cross-tenant candidates) is not
 * built. Where it would have helped, this module returns the `not-measured`
 * state rather than silence — see {@link UpgradeAvailability}.
 *
 * ## Everything here is org-scoped, and that is the whole tenancy story
 *
 * Tags live on `workload_containers`, which is tenant-scoped, so "what other
 * tags of this repository exist" is a question that can only be answered from
 * inside one org until phase 3's `image_tag_observations` exists. Chart
 * identity has the same shape: `helm_releases` is org-scoped, and a name-only
 * chart match is acceptable inside an org and never across one. Both candidate
 * queries below therefore take `orgId` as a required argument rather than an
 * optional filter, so forgetting it is a type error rather than a leak.
 *
 * Under [ADR 0006](../../../docs/adr/0006-images-are-cluster-scoped.md) an
 * image — and its SBOM — belongs to one *cluster*, but the queries here stay
 * org-scoped on purpose: a candidate scanned in the prod cluster is still a
 * valid recommendation for staging, with the findings diff reading prod's
 * image row. That is a deliberate org-level read of cluster-scoped data —
 * reads within an org were never the threat 0006 closes.
 */

import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { HelmRelease } from "../db/schema/helm-releases.js";
import {
    chartAttributionRepository,
    type ChartAttributionForOrg,
} from "../repositories/chart-attribution.repository.js";
import { chartObservationRepository } from "../repositories/chart-observation.repository.js";
import { findPlatform } from "./platform.service.js";
import { kubeCompatibility } from "../lib/kube-constraint.js";
import { isIndexableRepoUrl } from "../lib/chart-repo.js";
import { pairRepository } from "../lib/public-registries.js";
import { comparableFindings, diffFindings, resolvedByScope, summariseDelta, type DeltaSummary, type FindingDelta, type ScopeCounts } from "../db/finding-delta.js";
import { bestNewerTag, bumpKind, compareTags, type IncomparableReason, type VersionBump } from "../lib/image-tags.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("upgrade-recommendation");

/**
 * Why there is no recommendation, when there is none.
 *
 * `not-measured` is the state the proposal insists must be distinct from both
 * "no newer version" and "no fix available". Collapsing them tells a customer
 * their image is current when the truth is that nobody has scanned the newer
 * tag. It only arises on the chart axis today, where a newer chart version can
 * be *known* from another release without its images having been scanned; on
 * the image axis every candidate is a digest we hold an SBOM for by
 * construction, so phase 3 is what makes it reachable there too.
 */
export type UpgradeAvailability =
    | "available"
    | "up-to-date"
    | "no-candidates"
    | "not-measured"
    | "ambiguous-ordering";

export interface TagCandidate {
    tag: string;
    imageId: string;
    digest: string;
    bump: VersionBump;
    summary: DeltaSummary;
    /** `summary.resolved`, split into application packages and the base image. */
    resolvedByScope: ScopeCounts;
}

export interface ImageUpgradeRecommendation {
    availability: UpgradeAvailability;
    /** The digest and tag being moved *from*. */
    current: { imageId: string; digest: string; repository: string | null; tag: string | null };
    /** The recommended move. Null unless `availability` is `available`. */
    best: TagCandidate | null;
    /** Every comparable newer tag, best first — the "other options" list. */
    candidates: TagCandidate[];
    /**
     * Tags of the same repository we refused to order, and why. Surfaced rather
     * than dropped: "we found three tags but cannot tell you whether they are
     * newer" is a real answer and the acceptance criteria require it.
     */
    skipped: Array<{ tag: string; reason: IncomparableReason }>;
    /** The findings the bump does *not* fix. Empty when there is no bump. */
    remaining: FindingDelta["unchanged"];
}

/**
 * How many candidate tags are diffed before the list is truncated.
 *
 * A repository with fifty scanned tags would otherwise mean fifty finding
 * diffs to answer a question about the newest few. The truncation is logged
 * rather than silent — a bounded result that reads as exhaustive is the failure
 * mode the proposal's "no silent caps" note is about.
 */
const MAX_CANDIDATES_DIFFED = 5;

/**
 * Ceiling on how many images one org-wide scan will price.
 *
 * The scan is a recommendation query per image, and each of those is several
 * finding diffs, so it is the one endpoint here whose cost grows with fleet
 * size. The pre-filter below removes most of the growth — an image whose
 * repository this org runs at only one digest cannot have a candidate — and
 * this is the backstop for an org that genuinely runs hundreds of multi-tag
 * repositories. Exceeding it is logged, never silent.
 */
const MAX_IMAGES_EXAMINED = 200;

/**
 * A newer tag of the same repository, already scanned by this org, and what
 * moving to it would clear.
 *
 * The candidate set comes from `workload_containers.imageTag` joined through
 * `images.repository` — the customer already running several versions of the
 * same image across namespaces or clusters, which is the common case the
 * proposal was written for and needs no new schema.
 */
export async function recommendForImage(
    orgId: string,
    imageId: string
): Promise<ImageUpgradeRecommendation> {
    const [current] = await db
        .select({
            id: schema.images.id,
            digest: schema.images.digest,
            registry: schema.images.registry,
            repository: schema.images.repository,
        })
        .from(schema.images)
        .where(eq(schema.images.id, imageId));

    if (!current) throw new Error(`Image ${imageId} not found`);

    // The tag this org deploys this digest under. A digest may carry several
    // tags even inside one org (`1.25` and `1.25.2` pointing at the same
    // bytes); the most specific is the one worth comparing from, because
    // comparing from `1.25` refuses every candidate on the precision rule and
    // reports "ambiguous" for a repository that is perfectly orderable.
    const currentTags = await db
        .selectDistinct({ tag: schema.workloadContainers.imageTag })
        .from(schema.workloadContainers)
        .where(
            and(
                eq(schema.workloadContainers.orgId, orgId),
                eq(schema.workloadContainers.imageId, imageId),
                isNotNull(schema.workloadContainers.imageTag)
            )
        );

    const currentTag = mostSpecificTag(currentTags.map((r) => r.tag!));

    const base = {
        current: {
            imageId: current.id,
            digest: current.digest,
            repository: current.repository,
            tag: currentTag,
        },
        best: null,
        candidates: [],
        skipped: [],
        remaining: [],
    };

    // A digest-pinned deployment has no tag, which is a legitimate state and
    // not a gap in our data. There is nothing to compare a null against, and
    // saying "up to date" would be a claim we have not checked.
    if (!currentTag) return { ...base, availability: "no-candidates" };
    if (!current.repository) return { ...base, availability: "no-candidates" };

    // Candidates: other digests of the same repository that this org runs, with
    // a tag, that have an SBOM. The SBOM join is what makes this phase 1 rather
    // than phase 3 — an unscanned newer tag cannot be diffed, and inventing a
    // recommendation from a version number alone is the thing this feature is
    // not.
    const rawCandidateRows = await db
        .selectDistinct({
            imageId: schema.images.id,
            digest: schema.images.digest,
            tag: schema.workloadContainers.imageTag,
        })
        .from(schema.workloadContainers)
        .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
        .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
        .where(
            and(
                eq(schema.workloadContainers.orgId, orgId),
                eq(schema.images.repository, current.repository),
                // Same repository under a different registry is the same image
                // mirrored, and `images` says so explicitly: registry is
                // descriptive and never part of identity.
                ne(schema.images.id, imageId),
                // Cluster-scoped images (ADR 0006) make the *same digest* a
                // separate row per cluster — including the digest we are
                // upgrading *from*, whose sibling rows are not candidates.
                ne(schema.images.digest, current.digest),
                isNotNull(schema.workloadContainers.imageTag)
            )
        );

    // One candidate per digest. The same digest deployed in two clusters is
    // two image rows since ADR 0006; any of them can carry the diff (each row
    // here has an SBOM by construction — the join is inner), so keep the
    // first.
    const seenDigests = new Set<string>();
    const candidateRows = rawCandidateRows.filter((r) => {
        const key = `${r.digest} ${r.tag}`;
        if (seenDigests.has(key)) return false;
        seenDigests.add(key);
        return true;
    });

    if (candidateRows.length === 0) return { ...base, availability: "no-candidates" };

    const { newer, incomparable } = bestNewerTag(
        currentTag,
        candidateRows.map((r) => r.tag!)
    );

    const skipped = dedupeSkipped(incomparable);

    if (newer.length === 0) {
        // Two different answers, and the distinction is the point: we compared
        // and yours is newest, versus we could not compare anything at all.
        return {
            ...base,
            skipped,
            availability: skipped.length > 0 ? "ambiguous-ordering" : "up-to-date",
        };
    }

    const tagToImage = new Map<string, { imageId: string; digest: string }>();
    for (const row of candidateRows) {
        // A tag maps to one digest per org at a time; if two rows disagree the
        // inventory caught a rollout, and either digest is a truthful answer.
        if (!tagToImage.has(row.tag!)) {
            tagToImage.set(row.tag!, { imageId: row.imageId, digest: row.digest });
        }
    }

    const diffed = newer.slice(0, MAX_CANDIDATES_DIFFED);
    if (newer.length > diffed.length) {
        log.info(
            { imageId, repository: current.repository, found: newer.length, diffed: diffed.length },
            "Truncated upgrade candidate list"
        );
    }

    const targetIds = diffed
        .map((tag) => tagToImage.get(tag)?.imageId)
        .filter((id): id is string => id != null);

    const sets = await comparableFindings([imageId, ...targetIds]);
    const from = sets.get(imageId) ?? [];

    const candidates: TagCandidate[] = [];
    let bestDelta: FindingDelta | null = null;

    for (const tag of diffed) {
        const target = tagToImage.get(tag);
        if (!target) continue;
        const delta = diffFindings(imageId, target.imageId, from, sets.get(target.imageId) ?? []);
        candidates.push({
            tag,
            imageId: target.imageId,
            digest: target.digest,
            bump: bumpKind(currentTag, tag),
            summary: summariseDelta(delta),
            resolvedByScope: resolvedByScope(delta),
        });
        // `diffed` is newest-first, so the first one is the recommendation.
        // Ordering by "clears the most findings" instead would sometimes
        // recommend an older tag over a newer one, which is not a coherent
        // thing to tell someone.
        bestDelta ??= delta;
    }

    if (candidates.length === 0) {
        return { ...base, skipped, availability: "no-candidates" };
    }

    return {
        current: base.current,
        availability: "available",
        best: candidates[0]!,
        candidates,
        skipped,
        remaining: bestDelta?.unchanged ?? [],
    };
}

/**
 * The most specific tag among several pointing at one digest.
 *
 * "Most specific" is the most version components: `1.25.2` over `1.25` over
 * `1`. A tag with no numeric version loses to any that has one, and `latest`
 * therefore never wins unless it is the only tag — in which case there is
 * nothing to compare from anyway.
 */
function mostSpecificTag(tags: string[]): string | null {
    if (tags.length === 0) return null;
    let best = tags[0]!;
    for (const tag of tags.slice(1)) {
        const cmp = compareTags(best, tag);
        if (cmp.comparable) {
            // Same variant and precision — prefer the newer, which for tags on
            // one digest is a formality.
            if (cmp.order < 0) best = tag;
            continue;
        }
        const bestParts = best.split("-")[0]?.split(".").length ?? 0;
        const tagParts = tag.split("-")[0]?.split(".").length ?? 0;
        if (tagParts > bestParts) best = tag;
    }
    return best;
}

/** One row per tag, keeping the first reason. Several containers, same tag. */
function dedupeSkipped(
    entries: Array<{ tag: string; reason: IncomparableReason }>
): Array<{ tag: string; reason: IncomparableReason }> {
    const seen = new Map<string, IncomparableReason>();
    for (const entry of entries) {
        if (!seen.has(entry.tag)) seen.set(entry.tag, entry.reason);
    }
    return [...seen].map(([tag, reason]) => ({ tag, reason }));
}

// ---------------------------------------------------------------------------
// Phase 2 — the chart axis
// ---------------------------------------------------------------------------

/**
 * How a chart match was made. `repo-url` is the only *observed fact* — the
 * scanner saw the repository on the release. `attributed` is an evidence-backed
 * inference: the nightly attribution pass matched the installed version against
 * Artifact Hub's mirror (`lib/chart-attribution.ts`), which is stronger than a
 * name match but still an inference the UI labels distinctly. `chart-name` is a
 * guess the UI must label, because several repositories publish `nginx`.
 */
export type ChartMatchKind = "repo-url" | "attributed" | "chart-name";

/**
 * What backs a **measured** chart recommendation.
 *
 * - `sibling-release` — another release of the same chart in the same org
 *   already runs the target version with scanned images. Preferred whenever
 *   it exists.
 * - `platform-render` — the target version was rendered from its public
 *   tarball with **default values** and its images scanned by the platform
 *   scanner (measuring-candidate-charts.md). What it may claim is exactly
 *   what a sibling measurement may claim — the finding delta of the image
 *   moves — and the copy must say the measurement comes from the chart's
 *   default configuration.
 */
export type ChartEvidence = "sibling-release" | "platform-render";

export interface ChartUpgradeRecommendation {
    availability: UpgradeAvailability;
    release: {
        id: string;
        name: string;
        namespace: string;
        chartName: string | null;
        chartVersion: string | null;
        /** Context for the unmeasured card's app-version line — never evidence. */
        appVersion: string | null;
        repoUrl: string | null;
        /** The attribution's repo when `repoUrl` is null and one exists. An inference. */
        attributedRepoUrl: string | null;
    };
    /**
     * The newer chart version being compared against. A sibling target names
     * the release that runs it; a platform-render target has no release
     * anywhere — `releaseId`, `cluster` and `namespace` are null, and the
     * version was measured from the chart's own tarball.
     */
    target: {
        releaseId: string | null;
        chartVersion: string;
        /** The target version's `appVersion` — context, never evidence. */
        appVersion: string | null;
        /** Where it runs — a different cluster or namespace in the same org. */
        cluster: string | null;
        namespace: string | null;
    } | null;
    /** Set exactly when `availability` is `available`. */
    evidence: ChartEvidence | null;
    matchKind: ChartMatchKind | null;
    /**
     * Which component of the chart version moved. A major bump can change the
     * values schema, which is a different class of risk from a tag bump, so the
     * proposal requires saying which one this is.
     */
    bump: VersionBump;
    /** Images the chart bump would move, with the delta for each. */
    imageMoves: Array<{
        fromImageId: string;
        fromDigest: string;
        toImageId: string;
        toDigest: string;
        repository: string | null;
        summary: DeltaSummary;
        resolvedByScope: ScopeCounts;
    }>;
    /**
     * The stated coverage gap. Sibling evidence: digests the newer release
     * deploys that we hold no SBOM for. Platform evidence: the running images
     * the default render did not produce or could not be measured against —
     * unresolved refs, unscanned candidate digests, unscanned current images.
     * Both mismatch directions degrade to this number, never to a wrong one.
     */
    unmeasuredImages: number;
    /** How the change is delivered — `targetRevision` when ArgoCD owns it. */
    delivery: { tool: string; appName: string; targetRevision: string | null } | null;
    /** Chart versions seen that could not be ordered against this one. */
    skipped: Array<{ chartVersion: string; reason: IncomparableReason }>;
    /**
     * When the sibling scan found nothing (`no-candidates` / `up-to-date`) but
     * the attributed Artifact Hub package lists something newer. A separate,
     * honestly-unmeasured statement — nothing has scanned what it deploys —
     * and never a `target`. Deprecated versions are skipped; `kube` is the
     * target's kubeVersion constraint, when it declares one.
     */
    mirrorNewer: { version: string; kube: string | null } | null;
    /**
     * The suggested version's `kubeVersion` constraint excludes this cluster.
     * Present only when both sides are known (`lib/kube-constraint.ts`
     * returned `excluded`); every unknown renders as silence.
     */
    kubeWarning: { clusterVersion: string; kubeRange: string } | null;
}

/**
 * Another release of the same chart, at a newer version, and the finding delta
 * of the digests it would move.
 *
 * Chart identity is `(repoUrl, chartName)` when `repoUrl` is observed, the
 * attributed repository when the nightly pass inferred one, and a name-only
 * match otherwise — each labelled by `matchKind`, and never crossing a tenant
 * boundary.
 * `appVersion` is not consulted at all: the schema is explicit that its
 * equality with `chartVersion` is not derivation, and the proof a fix landed is
 * the measured digest.
 */
export async function recommendForRelease(
    orgId: string,
    releaseId: string
): Promise<ChartUpgradeRecommendation> {
    const { release, attribution } = await resolveChartAttribution(orgId, releaseId);

    const base: ChartUpgradeRecommendation = {
        availability: "no-candidates",
        release: {
            id: release.id,
            name: release.name,
            namespace: release.namespace,
            chartName: release.chartName,
            chartVersion: release.chartVersion,
            appVersion: release.appVersion,
            repoUrl: release.repoUrl,
            /** Only ever the *inferred* repo: an observed one is not attributed. */
            attributedRepoUrl: release.repoUrl ? null : (attribution?.repoUrl ?? null),
        },
        target: null,
        evidence: null,
        matchKind: null,
        bump: "none",
        imageMoves: [],
        unmeasuredImages: 0,
        delivery: null,
        skipped: [],
        mirrorNewer: null,
        kubeWarning: null,
    };

    if (!release.chartName || !release.chartVersion) return base;

    // The mirror is the only source of `kubeVersion` ranges, so the cluster
    // version is only worth fetching when an attribution exists.
    const clusterVersion = attribution
        ? ((
              await db
                  .select({ v: schema.clusters.kubernetesVersion })
                  .from(schema.clusters)
                  .where(eq(schema.clusters.id, release.clusterId))
          )[0]?.v ?? null)
        : null;

    const matchKind: ChartMatchKind = release.repoUrl
        ? "repo-url"
        : attribution
          ? "attributed"
          : "chart-name";

    const ctx: ReleaseRecommendationContext = {
        orgId,
        releaseId,
        release,
        chartName: release.chartName,
        chartVersion: release.chartVersion,
        attribution,
        matchKind,
        base,
        clusterVersion,
    };

    const sibling = await siblingReleaseCandidate(ctx);
    if (sibling.settled) return sibling.recommendation;

    // Every sibling dead end gives the platform-render path its chance before
    // the fallback card — a sibling measurement is preferred whenever one
    // exists, so only its absence reaches here.
    const platformRec = await platformRenderCandidate(ctx);
    if (platformRec) return platformRec;

    return sibling.fallback();
}

/**
 * What flows between the phases of {@link recommendForRelease}: the release
 * being priced, the attribution it may claim, and the skeleton every answer
 * spreads from. Assembled once, after the chart-identity guard, which is why
 * `chartName` and `chartVersion` carry the narrowed non-null values.
 */
interface ReleaseRecommendationContext {
    readonly orgId: string;
    readonly releaseId: string;
    readonly release: HelmRelease;
    /** `release.chartName`, narrowed by the guard in the orchestrator. */
    readonly chartName: string;
    /** `release.chartVersion`, narrowed the same way. */
    readonly chartVersion: string;
    /** The attribution this release may claim — repo agreement already checked. */
    readonly attribution: ChartAttributionForOrg | undefined;
    readonly matchKind: ChartMatchKind;
    /** The all-nulls answer every return builds on. */
    readonly base: ChartUpgradeRecommendation;
    /** Fetched only when an attribution exists — the mirror is the only source of ranges. */
    readonly clusterVersion: string | null;
}

/**
 * The release row, and the chart attribution it is allowed to claim.
 *
 * The attribution is consulted whether or not the scanner observed a repo,
 * but it may only *speak* for this release when the two agree — the same
 * rule the release detail payload applies. Standing in for an unobserved
 * repo is one of its jobs; the other is being the only version list we
 * hold for a chart nobody else in the org runs, and gating that on a null
 * `repoUrl` meant the releases we know most about were the ones we could
 * say least about. A *different* observed repo still refuses: same chart
 * name, different chart.
 */
async function resolveChartAttribution(
    orgId: string,
    releaseId: string
): Promise<{ release: HelmRelease; attribution: ChartAttributionForOrg | undefined }> {
    const [release] = await db
        .select()
        .from(schema.helmReleases)
        .where(and(eq(schema.helmReleases.id, releaseId), eq(schema.helmReleases.orgId, orgId)));

    if (!release) throw new Error(`Release ${releaseId} not found in org ${orgId}`);

    const attributionRow = release.chartName
        ? await chartAttributionRepository.findForChart(orgId, release.chartName)
        : undefined;
    const attribution =
        attributionRow && (!release.repoUrl || release.repoUrl === attributionRow.repoUrl)
            ? attributionRow
            : undefined;

    return { release, attribution };
}

/** `excluded` with both sides known, or nothing — never a guess. */
function kubeWarningFor(
    clusterVersion: string | null,
    kubeRange: string | null
): { clusterVersion: string; kubeRange: string } | null {
    return clusterVersion && kubeRange && kubeCompatibility(clusterVersion, kubeRange) === "excluded"
        ? { clusterVersion, kubeRange }
        : null;
}

/** The `kubeVersion` range the mirror lists for one chart version, if any. */
function attributedKubeRange(
    attribution: ChartAttributionForOrg | undefined,
    version: string
): string | null {
    return attribution?.versions.find((entry) => entry.pkg === version)?.kube ?? null;
}

/**
 * The mirror's "newer exists" fallback — only offered where the sibling
 * scan came up empty-handed, and never as a `target`: an Artifact Hub
 * version is a listing, not a release anyone here runs.
 */
function mirrorNewerVersion(
    ctx: ReleaseRecommendationContext
): { version: string; kube: string | null } | null {
    if (!ctx.attribution) return null;
    const { best } = bestNewerTag(
        ctx.chartVersion,
        ctx.attribution.versions.filter((v) => !v.deprecated).map((v) => v.pkg)
    );
    if (!best) return null;
    const entry = ctx.attribution.versions.find((v) => v.pkg === best);
    return { version: best, kube: entry?.kube ?? null };
}

/**
 * How the sibling scan resolves: a settled recommendation, or a fallback the
 * orchestrator uses only after the platform-render path has had its chance —
 * the unsettled cases are exactly the "no measured sibling" states. The
 * fallback is a thunk so that anything it fetches (the delivery row) stays
 * unfetched when the platform answer wins.
 */
type SiblingScanResult =
    | { settled: true; recommendation: ChartUpgradeRecommendation }
    | {
          settled: false;
          fallback: () => ChartUpgradeRecommendation | Promise<ChartUpgradeRecommendation>;
      };

/**
 * The sibling-release candidate: another release of the same chart in the
 * same org at a newer version, and the measured delta of the image moves.
 * Preferred over platform evidence whenever it measures anything, which is
 * why every dead end here returns a fallback rather than an answer.
 */
async function siblingReleaseCandidate(
    ctx: ReleaseRecommendationContext
): Promise<SiblingScanResult> {
    const { release, attribution, base, matchKind } = ctx;

    const siblings = await db
        .select({
            release: schema.helmReleases,
            clusterName: schema.clusters.name,
        })
        .from(schema.helmReleases)
        .innerJoin(schema.clusters, eq(schema.helmReleases.clusterId, schema.clusters.id))
        .where(
            and(
                eq(schema.helmReleases.orgId, ctx.orgId),
                eq(schema.helmReleases.chartName, ctx.chartName),
                ne(schema.helmReleases.id, ctx.releaseId),
                isNotNull(schema.helmReleases.chartVersion),
                // When we know the repo, require agreement. When we only have
                // an attribution, siblings must either agree with it or carry
                // no repo at all — a null-repo sibling of the same (org, chart)
                // shares the attribution row by construction, while a sibling
                // with a *different observed* repo is a different chart. When
                // we have neither, the match is by name and the caller is told
                // so — what the UI's `chartNameAmbiguous` flag already covers.
                ...(release.repoUrl
                    ? [eq(schema.helmReleases.repoUrl, release.repoUrl)]
                    : attribution
                      ? [
                            or(
                                eq(schema.helmReleases.repoUrl, attribution.repoUrl),
                                isNull(schema.helmReleases.repoUrl)
                            )!,
                        ]
                      : [])
            )
        );

    if (siblings.length === 0) {
        // No sibling anywhere — the single-cluster customer, and every
        // evaluator. This is exactly who the platform-render path exists for.
        return {
            settled: false,
            fallback: () => {
                const mirror = mirrorNewerVersion(ctx);
                return {
                    ...base,
                    matchKind,
                    mirrorNewer: mirror,
                    kubeWarning: mirror ? kubeWarningFor(ctx.clusterVersion, mirror.kube) : null,
                };
            },
        };
    }

    // Helm mandates SemVer 2 for chart versions, so unlike image tags the
    // ordering here is decidable. `compareTags` is still the comparator — a
    // SemVer string is a dotted numeric version with an optional pre-release,
    // which is precisely the subset it orders — and its refusals map onto the
    // pre-release rule, which is the right answer for a chart too.
    const { newer, incomparable } = bestNewerTag(
        ctx.chartVersion,
        siblings.map((s) => s.release.chartVersion!)
    );

    const skipped = incomparable.map((e) => ({ chartVersion: e.tag, reason: e.reason }));

    if (newer.length === 0) {
        // "Up to date among siblings" is a weaker statement than it reads:
        // the platform may have measured a version nobody in the org runs,
        // and the mirror may still list something newer than that.
        return {
            settled: false,
            fallback: () => {
                const mirror = skipped.length > 0 ? null : mirrorNewerVersion(ctx);
                return {
                    ...base,
                    matchKind,
                    skipped,
                    availability: skipped.length > 0 ? "ambiguous-ordering" : "up-to-date",
                    mirrorNewer: mirror,
                    kubeWarning: mirror ? kubeWarningFor(ctx.clusterVersion, mirror.kube) : null,
                };
            },
        };
    }

    const targetVersion = newer[0]!;
    const target = siblings.find((s) => s.release.chartVersion === targetVersion)!;

    const [fromImages, toImages] = await Promise.all([
        imagesForRelease(ctx.releaseId),
        imagesForRelease(target.release.id),
    ]);

    // Pair by repository. A chart bump that moves `nginx` from one digest to
    // another is one move; a chart that adds a sidecar image entirely is not a
    // "move" and shows up as unmeasured-or-new rather than a delta against
    // nothing.
    const toByRepo = new Map(toImages.map((i) => [i.repository ?? i.digest, i]));
    const moves: Array<{ from: (typeof fromImages)[number]; to: (typeof toImages)[number] }> = [];
    for (const from of fromImages) {
        const to = toByRepo.get(from.repository ?? from.digest);
        if (to && to.imageId !== from.imageId) moves.push({ from, to });
    }

    const unmeasured = toImages.filter((i) => !i.scanned).length;

    if (moves.length === 0) {
        // The newer chart exists and we know its version, but nothing it
        // deploys differs from what is already running — or we hold no SBOM for
        // the digests that do. Those are different answers. Either way there
        // is no measured sibling, so the platform may still measure it.
        return {
            settled: false,
            fallback: () => ({
                ...base,
                matchKind,
                skipped,
                target: {
                    releaseId: target.release.id,
                    chartVersion: targetVersion,
                    appVersion: target.release.appVersion,
                    cluster: target.clusterName,
                    namespace: target.release.namespace,
                },
                bump: bumpKind(ctx.chartVersion, targetVersion),
                unmeasuredImages: unmeasured,
                availability: unmeasured > 0 ? "not-measured" : "up-to-date",
                mirrorNewer: unmeasured > 0 ? null : mirrorNewerVersion(ctx),
                kubeWarning: kubeWarningFor(
                    ctx.clusterVersion,
                    attributedKubeRange(attribution, targetVersion)
                ),
            }),
        };
    }

    const measurable = moves.filter((m) => m.from.scanned && m.to.scanned);
    const imageMoves = await priceImageMoves(
        measurable.map((m) => ({
            fromImageId: m.from.imageId,
            fromDigest: m.from.digest,
            toImageId: m.to.imageId,
            toDigest: m.to.digest,
            repository: m.from.repository,
        }))
    );

    const finalise = async (): Promise<ChartUpgradeRecommendation> => ({
        ...base,
        matchKind,
        skipped,
        target: {
            releaseId: target.release.id,
            chartVersion: targetVersion,
            appVersion: target.release.appVersion,
            cluster: target.clusterName,
            namespace: target.release.namespace,
        },
        evidence: imageMoves.length > 0 ? "sibling-release" : null,
        bump: bumpKind(ctx.chartVersion, targetVersion),
        imageMoves,
        unmeasuredImages: unmeasured + (moves.length - measurable.length),
        delivery: await deliveryForRelease(ctx.releaseId),
        availability: imageMoves.length > 0 ? "available" : "not-measured",
        kubeWarning: kubeWarningFor(
            ctx.clusterVersion,
            attributedKubeRange(attribution, targetVersion)
        ),
    });

    if (imageMoves.length === 0) {
        // Moves exist but none was measurable on both sides — still no
        // measured sibling, so the platform gets its chance before the
        // release settles for the unmeasured card.
        return { settled: false, fallback: finalise };
    }

    return { settled: true, recommendation: await finalise() };
}

/**
 * The platform-render candidate source — measuring-candidate-charts.md
 * phase 3, tried only when no measured sibling exists (a sibling
 * measurement is preferred whenever both exist).
 *
 * This function **is** the read gate. Tenant queries reach platform-cluster
 * findings only through the candidate path walked here: the tenant's own
 * release → its observed or attributed repo (http(s), and not one this
 * org reads with credentials) → `chart_image_observations` → platform
 * images. There is no other join, and no general "read the platform org"
 * escape hatch exists anywhere.
 */
async function platformRenderCandidate(
    ctx: ReleaseRecommendationContext
): Promise<ChartUpgradeRecommendation | null> {
    const { release, attribution, base, matchKind } = ctx;

    const repoUrl = release.repoUrl ?? attribution?.repoUrl ?? null;
    if (!repoUrl || !isIndexableRepoUrl(repoUrl)) return null;

    // A repo this org fetches with credentials may be private; a private
    // chart must never be answered from platform rows, even if a public
    // chart happens to share the URL.
    const [repoRow] = await db
        .select({
            username: schema.chartRepositories.username,
            password: schema.chartRepositories.password,
        })
        .from(schema.chartRepositories)
        .where(
            and(
                eq(schema.chartRepositories.orgId, ctx.orgId),
                eq(schema.chartRepositories.url, repoUrl)
            )
        );
    if (repoRow && (repoRow.username != null || repoRow.password != null)) return null;

    const platform = await findPlatform();
    if (!platform) return null;

    const renders = await chartObservationRepository.rendersForChart(repoUrl, ctx.chartName);
    const renderedVersions = renders
        .filter((r) => r.status === "rendered")
        .map((r) => r.chartVersion);
    if (renderedVersions.length === 0) return null;

    const { newer } = bestNewerTag(ctx.chartVersion, renderedVersions);
    if (newer.length === 0) return null;

    const fromImages = await imagesForRelease(ctx.releaseId);

    // Newest first; the first version with at least one measurable move
    // wins. Bounded — versions past the first few are not worth a query
    // fan-out, and the newest measurable one is the honest answer.
    for (const targetVersion of newer.slice(0, 3)) {
        const observations = await chartObservationRepository.observationsForVersion(
            repoUrl,
            ctx.chartName,
            targetVersion
        );
        if (observations.length === 0) continue;

        const platformImages = await chartObservationRepository.platformImagesForDigests(
            platform.clusterId,
            observations.map((o) => o.digest).filter((d): d is string => d != null)
        );

        // Pair by repository — the same rule the sibling path uses — with
        // docker.io shorthand normalised on both sides. Rendered images
        // the customer does not run pair with nothing and drop out;
        // everything unpairable or unmeasurable on the customer's side is
        // counted, stated, and never guessed at.
        const obsByRepo = new Map<string, (typeof observations)[number]>();
        for (const obs of observations) {
            const key = pairRepository(obs.registry, obs.repository);
            if (!obsByRepo.has(key)) obsByRepo.set(key, obs);
        }

        const pairs: Array<{
            fromImageId: string;
            fromDigest: string;
            repository: string | null;
            toImageId: string;
            toDigest: string;
        }> = [];
        let unmeasured = 0;
        for (const from of fromImages) {
            const obs = from.repository
                ? obsByRepo.get(pairRepository(from.registry, from.repository))
                : undefined;
            if (!obs) {
                // The default render does not produce this image — a
                // values-enabled extra on the customer's side. Stated.
                unmeasured += 1;
                continue;
            }
            if (obs.digest == null) {
                unmeasured += 1; // unresolved rows measure nothing
                continue;
            }
            // Pair on the customer's *actual* digest: when their current
            // digest already equals the candidate's, the chart moves
            // nothing for them, whatever the current-version render said.
            if (obs.digest === from.digest) continue;
            const toImageId = platformImages.get(obs.digest);
            if (!from.scanned || !toImageId) {
                unmeasured += 1;
                continue;
            }
            pairs.push({
                fromImageId: from.imageId,
                fromDigest: from.digest,
                repository: from.repository,
                toImageId,
                toDigest: obs.digest,
            });
        }
        if (pairs.length === 0) continue;

        const imageMoves = await priceImageMoves(pairs);

        return {
            ...base,
            matchKind,
            target: {
                releaseId: null,
                chartVersion: targetVersion,
                appVersion:
                    attribution?.versions.find((v) => v.pkg === targetVersion)?.app ?? null,
                cluster: null,
                namespace: null,
            },
            evidence: "platform-render",
            bump: bumpKind(ctx.chartVersion, targetVersion),
            imageMoves,
            unmeasuredImages: unmeasured,
            delivery: await deliveryForRelease(ctx.releaseId),
            availability: "available",
            kubeWarning: kubeWarningFor(
                ctx.clusterVersion,
                attributedKubeRange(attribution, targetVersion)
            ),
        };
    }
    return null;
}

/**
 * Price a set of image moves: one batched findings read, then the delta and
 * its summary per pair. Shared by both evidence paths — a platform-render
 * pair and a sibling pair are the same measurement once paired.
 */
async function priceImageMoves(
    pairs: Array<{
        fromImageId: string;
        fromDigest: string;
        toImageId: string;
        toDigest: string;
        repository: string | null;
    }>
): Promise<ChartUpgradeRecommendation["imageMoves"]> {
    const sets = await comparableFindings([
        ...pairs.map((p) => p.fromImageId),
        ...pairs.map((p) => p.toImageId),
    ]);
    return pairs.map((pair) => {
        const delta = diffFindings(
            pair.fromImageId,
            pair.toImageId,
            sets.get(pair.fromImageId) ?? [],
            sets.get(pair.toImageId) ?? []
        );
        return {
            fromImageId: pair.fromImageId,
            fromDigest: pair.fromDigest,
            toImageId: pair.toImageId,
            toDigest: pair.toDigest,
            repository: pair.repository,
            summary: summariseDelta(delta),
            resolvedByScope: resolvedByScope(delta),
        };
    });
}

/** Distinct images a release deploys, and whether we hold an SBOM for each. */
async function imagesForRelease(releaseId: string) {
    return db
        .selectDistinct({
            imageId: schema.images.id,
            digest: schema.images.digest,
            registry: schema.images.registry,
            repository: schema.images.repository,
            scanned: sql<boolean>`${schema.sboms.id} IS NOT NULL`,
        })
        .from(schema.workloadContainers)
        .innerJoin(schema.workloads, eq(schema.workloadContainers.workloadId, schema.workloads.id))
        .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
        .leftJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
        .where(eq(schema.workloads.releaseId, releaseId));
}

/**
 * What delivers this release, if anything — the difference between "run
 * `helm upgrade`" and "bump `targetRevision` on the Argo app, or your next sync
 * will revert it".
 */
async function deliveryForRelease(releaseId: string) {
    const [row] = await db
        .selectDistinct({
            tool: schema.gitopsApplications.tool,
            appName: schema.gitopsApplications.name,
            targetRevision: schema.gitopsApplications.targetRevision,
        })
        .from(schema.workloads)
        .innerJoin(
            schema.gitopsApplications,
            eq(schema.workloads.applicationId, schema.gitopsApplications.id)
        )
        .where(eq(schema.workloads.releaseId, releaseId));
    return row ?? null;
}

/**
 * Whether a recommendation may claim a workload is unmanaged.
 *
 * `clusters.owner_metadata_collected = false` means the agent could not read
 * controllers, so a workload with no release row may well be chart-managed.
 * Emitting "not chart-managed, use `kubectl set image`" on that evidence states
 * a fact about a customer's cluster that we did not establish — the same null
 * the inventory contract spends a section on. Callers rendering an
 * image-scoped instruction must gate it on this.
 */
export async function ownerMetadataKnown(clusterId: string): Promise<boolean> {
    const [row] = await db
        .select({ collected: schema.clusters.ownerMetadataCollected })
        .from(schema.clusters)
        .where(eq(schema.clusters.id, clusterId));
    return row?.collected === true;
}

/**
 * Every image in the org with a recommendation, worst first.
 *
 * The bulk-fix screen: "show me every workload that would benefit from one
 * bump", which `remediation-workflow.md` frames as the real analogue of
 * Aikido's Bulk Fix. Ordered by how much risk the move removes, not by how many
 * findings — a bump clearing one KEV critical beats one clearing forty
 * unexploited lows, and the point of the score is to say so.
 */
export async function recommendationsForOrg(
    orgId: string,
    limit = 25
): Promise<ImageUpgradeRecommendation[]> {
    const { settled } = await upgradeScanForOrg(orgId);

    // Ordered by risk removed, not by findings cleared. A bump clearing one KEV
    // critical beats one clearing forty unexploited lows, and the whole point of
    // having a score is to be able to say so. `riskChange` is negative for an
    // improvement, so ascending puts the best move first.
    return settled
        .filter((r) => r.availability === "available")
        .sort((a, b) => (a.best?.summary.riskChange ?? 0) - (b.best?.summary.riskChange ?? 0))
        .slice(0, limit);
}

/**
 * The org-wide scan behind {@link recommendationsForOrg}, with the refusals
 * kept. `settled` is every examined image's answer — `available` or one of
 * the four reasons there is no move — so a surface that lists images
 * *without* a recommendation (the Fixes page's "no recommendation yet"
 * section) can state why rather than render silence. An image absent from
 * `settled` was never examined: its repository runs at only one scanned
 * digest in this org, which is `no-candidates` by construction.
 */
export async function upgradeScanForOrg(
    orgId: string
): Promise<{ settled: ImageUpgradeRecommendation[]; truncated: boolean }> {
    // Only images whose repository this org runs at more than one digest can
    // possibly have a candidate — a second digest under the same repository is
    // what a candidate *is*. Filtering here rather than inside the loop is what
    // keeps this from being one recommendation query per image in the fleet;
    // on a typical cluster it drops a few hundred images to a handful.
    const repositories = db
        .select({ repository: schema.images.repository })
        .from(schema.workloadContainers)
        .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
        .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
        .where(
            and(
                eq(schema.workloadContainers.orgId, orgId),
                isNotNull(schema.images.repository),
                isNotNull(schema.workloadContainers.imageTag)
            )
        )
        // Distinct *digests*, not image ids: the same digest in two clusters
        // is two rows since ADR 0006, and two rows of one digest is not a
        // second version to recommend.
        .groupBy(schema.images.repository)
        .having(sql`count(DISTINCT ${schema.images.digest}) > 1`);

    const candidates = await db
        .selectDistinct({ imageId: schema.images.id })
        .from(schema.workloadContainers)
        .innerJoin(schema.images, eq(schema.workloadContainers.imageId, schema.images.id))
        .innerJoin(schema.sboms, eq(schema.sboms.imageId, schema.images.id))
        .where(
            and(
                eq(schema.workloadContainers.orgId, orgId),
                inArray(schema.images.repository, repositories)
            )
        );

    const examined = candidates.slice(0, MAX_IMAGES_EXAMINED);
    if (candidates.length > examined.length) {
        // Never let a bounded result read as an exhaustive one.
        log.warn(
            { orgId, candidates: candidates.length, examined: examined.length },
            "Truncated org-wide upgrade scan"
        );
    }

    const settled = await Promise.all(
        examined.map(({ imageId }) => recommendForImage(orgId, imageId))
    );

    return { settled, truncated: candidates.length > examined.length };
}
