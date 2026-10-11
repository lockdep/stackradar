/**
 * "Which image tag should this workload move to, and what does that buy?"
 *
 * Two axes over the same measurement:
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

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
    comparableFindings,
    diffFindings,
    resolvedByScope,
    summariseDelta,
    type DeltaSummary,
    type FindingDelta,
    type ScopeCounts,
} from "../db/finding-delta.js";
import { bestNewerTag, bumpKind, compareTags, type IncomparableReason, type VersionBump } from "../lib/image-tags.js";
import { createLogger } from "../lib/logger.js";
import {
    platformRenderCandidate,
    resolveChartAttribution,
    siblingReleaseCandidate,
    type ReleaseRecommendationContext,
} from "./release-candidates.js";

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
export type UpgradeAvailability = "available" | "up-to-date" | "no-candidates" | "not-measured" | "ambiguous-ordering";

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
export async function recommendForImage(orgId: string, imageId: string): Promise<ImageUpgradeRecommendation> {
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
                isNotNull(schema.workloadContainers.imageTag),
            ),
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
                isNotNull(schema.workloadContainers.imageTag),
            ),
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
        candidateRows.map((r) => r.tag!),
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
            "Truncated upgrade candidate list",
        );
    }

    const targetIds = diffed.map((tag) => tagToImage.get(tag)?.imageId).filter((id): id is string => id != null);

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
    entries: Array<{ tag: string; reason: IncomparableReason }>,
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
 *   scanner. What it may claim is exactly
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
export async function recommendForRelease(orgId: string, releaseId: string): Promise<ChartUpgradeRecommendation> {
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

    const matchKind: ChartMatchKind = release.repoUrl ? "repo-url" : attribution ? "attributed" : "chart-name";

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
 * The org-wide scan behind the fixes rollup, with the refusals kept.
 * `settled` is every examined image's answer — `available` or one of
 * the four reasons there is no move — so a surface that lists images
 * *without* a recommendation (the Fixes page's "no recommendation yet"
 * section) can state why rather than render silence. An image absent from
 * `settled` was never examined: its repository runs at only one scanned
 * digest in this org, which is `no-candidates` by construction.
 */
export async function upgradeScanForOrg(
    orgId: string,
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
                isNotNull(schema.workloadContainers.imageTag),
            ),
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
        .where(and(eq(schema.workloadContainers.orgId, orgId), inArray(schema.images.repository, repositories)));

    const examined = candidates.slice(0, MAX_IMAGES_EXAMINED);
    if (candidates.length > examined.length) {
        // Never let a bounded result read as an exhaustive one.
        log.warn(
            { orgId, candidates: candidates.length, examined: examined.length },
            "Truncated org-wide upgrade scan",
        );
    }

    const settled = await Promise.all(examined.map(({ imageId }) => recommendForImage(orgId, imageId)));

    return { settled, truncated: candidates.length > examined.length };
}
