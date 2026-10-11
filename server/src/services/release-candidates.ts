/**
 * The chart axis's candidate resolvers — what `recommendForRelease` in
 * `upgrade-recommendation.service.ts` composes. Three sources of a newer
 * chart version, in the order of the evidence each can offer:
 *
 * - a **sibling release** of the same chart in this org at a newer version,
 *   whose images the org has already scanned — a measured move;
 * - the **platform's render** of a newer version (`platform.service.ts`),
 *   scanned on the maintainers' side — measured, labelled as such;
 * - the **mirror** (Artifact Hub attribution or a chart repository's index),
 *   which knows a newer version exists and nothing about its images — the
 *   `not-measured` answer, never upgraded to a claim.
 *
 * Every resolver takes the one {@link ReleaseRecommendationContext} the
 * service assembles after its chart-identity guard, so `chartName` and
 * `chartVersion` are non-null by construction here.
 */

import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
import { comparableFindings, diffFindings, resolvedByScope, summariseDelta } from "../db/finding-delta.js";
import { bestNewerTag, bumpKind } from "../lib/image-tags.js";
import type { ChartMatchKind, ChartUpgradeRecommendation } from "./upgrade-recommendation.service.js";

/**
 * What flows between the phases of {@link recommendForRelease}: the release
 * being priced, the attribution it may claim, and the skeleton every answer
 * spreads from. Assembled once, after the chart-identity guard, which is why
 * `chartName` and `chartVersion` carry the narrowed non-null values.
 */
export interface ReleaseRecommendationContext {
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
export async function resolveChartAttribution(
    orgId: string,
    releaseId: string,
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
        attributionRow && (!release.repoUrl || release.repoUrl === attributionRow.repoUrl) ? attributionRow : undefined;

    return { release, attribution };
}

/** `excluded` with both sides known, or nothing — never a guess. */
export function kubeWarningFor(
    clusterVersion: string | null,
    kubeRange: string | null,
): { clusterVersion: string; kubeRange: string } | null {
    return clusterVersion && kubeRange && kubeCompatibility(clusterVersion, kubeRange) === "excluded"
        ? { clusterVersion, kubeRange }
        : null;
}

/** The `kubeVersion` range the mirror lists for one chart version, if any. */
export function attributedKubeRange(attribution: ChartAttributionForOrg | undefined, version: string): string | null {
    return attribution?.versions.find((entry) => entry.pkg === version)?.kube ?? null;
}

/**
 * The mirror's "newer exists" fallback — only offered where the sibling
 * scan came up empty-handed, and never as a `target`: an Artifact Hub
 * version is a listing, not a release anyone here runs.
 */
export function mirrorNewerVersion(ctx: ReleaseRecommendationContext): { version: string; kube: string | null } | null {
    if (!ctx.attribution) return null;
    const { best } = bestNewerTag(
        ctx.chartVersion,
        ctx.attribution.versions.filter((v) => !v.deprecated).map((v) => v.pkg),
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
export type SiblingScanResult =
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
export async function siblingReleaseCandidate(ctx: ReleaseRecommendationContext): Promise<SiblingScanResult> {
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
                      ? [or(eq(schema.helmReleases.repoUrl, attribution.repoUrl), isNull(schema.helmReleases.repoUrl))!]
                      : []),
            ),
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
        siblings.map((s) => s.release.chartVersion!),
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
                kubeWarning: kubeWarningFor(ctx.clusterVersion, attributedKubeRange(attribution, targetVersion)),
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
        })),
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
        kubeWarning: kubeWarningFor(ctx.clusterVersion, attributedKubeRange(attribution, targetVersion)),
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
 * The platform-render candidate source, tried only when no measured sibling
 * exists (a sibling
 * measurement is preferred whenever both exist).
 *
 * This function **is** the read gate. Tenant queries reach platform-cluster
 * findings only through the candidate path walked here: the tenant's own
 * release → its observed or attributed repo (http(s), and not one this
 * org reads with credentials) → `chart_image_observations` → platform
 * images. There is no other join, and no general "read the platform org"
 * escape hatch exists anywhere.
 */
export async function platformRenderCandidate(
    ctx: ReleaseRecommendationContext,
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
        .where(and(eq(schema.chartRepositories.orgId, ctx.orgId), eq(schema.chartRepositories.url, repoUrl)));
    if (repoRow && (repoRow.username != null || repoRow.password != null)) return null;

    const platform = await findPlatform();
    if (!platform) return null;

    const renders = await chartObservationRepository.rendersForChart(repoUrl, ctx.chartName);
    const renderedVersions = renders.filter((r) => r.status === "rendered").map((r) => r.chartVersion);
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
            targetVersion,
        );
        if (observations.length === 0) continue;

        const platformImages = await chartObservationRepository.platformImagesForDigests(
            platform.clusterId,
            observations.map((o) => o.digest).filter((d): d is string => d != null),
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
            const obs = from.repository ? obsByRepo.get(pairRepository(from.registry, from.repository)) : undefined;
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
                appVersion: attribution?.versions.find((v) => v.pkg === targetVersion)?.app ?? null,
                cluster: null,
                namespace: null,
            },
            evidence: "platform-render",
            bump: bumpKind(ctx.chartVersion, targetVersion),
            imageMoves,
            unmeasuredImages: unmeasured,
            delivery: await deliveryForRelease(ctx.releaseId),
            availability: "available",
            kubeWarning: kubeWarningFor(ctx.clusterVersion, attributedKubeRange(attribution, targetVersion)),
        };
    }
    return null;
}

/**
 * Price a set of image moves: one batched findings read, then the delta and
 * its summary per pair. Shared by both evidence paths — a platform-render
 * pair and a sibling pair are the same measurement once paired.
 */
export async function priceImageMoves(
    pairs: Array<{
        fromImageId: string;
        fromDigest: string;
        toImageId: string;
        toDigest: string;
        repository: string | null;
    }>,
): Promise<ChartUpgradeRecommendation["imageMoves"]> {
    const sets = await comparableFindings([...pairs.map((p) => p.fromImageId), ...pairs.map((p) => p.toImageId)]);
    return pairs.map((pair) => {
        const delta = diffFindings(
            pair.fromImageId,
            pair.toImageId,
            sets.get(pair.fromImageId) ?? [],
            sets.get(pair.toImageId) ?? [],
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
export async function imagesForRelease(releaseId: string) {
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
export async function deliveryForRelease(releaseId: string) {
    const [row] = await db
        .selectDistinct({
            tool: schema.gitopsApplications.tool,
            appName: schema.gitopsApplications.name,
            targetRevision: schema.gitopsApplications.targetRevision,
        })
        .from(schema.workloads)
        .innerJoin(schema.gitopsApplications, eq(schema.workloads.applicationId, schema.gitopsApplications.id))
        .where(eq(schema.workloads.releaseId, releaseId));
    return row ?? null;
}
