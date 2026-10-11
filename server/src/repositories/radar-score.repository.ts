import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { collapsedFindings, deployedImagesIn, type FindingScope } from "../db/findings.js";
import { aggregateRiskSql, riskBand, type RiskBand } from "../db/risk-model.js";
import { NOTABLE_EPSS } from "../db/risk.js";
import {
    emptyTierCounts,
    inTierLens,
    shownDespiteTierSql,
    tierCountColumns,
    type TierCounts,
    type TierLens,
} from "../db/finding-tier.js";

/**
 * One image's share of a Radar Score — the row unit of the Radar Score tab
 * (one cluster) and of the org-wide `/radar-score` page (every cluster).
 *
 * The image is the unit because it is the only one that *partitions* the
 * total: a finding belongs to exactly one image (ADR 0004) and an image to
 * exactly one cluster (ADR 0006), so the `score`s on this list add up to the
 * number on the Overview's Radar Score chart — and, summed across clusters,
 * to the Dashboard's. Workloads would not — two workloads on one image share
 * its findings, and listing them would count the same CVE twice. The
 * workloads running the image ride along as context so the reader can still
 * get from "this image" to "that deployment".
 */
export type ClusterRadarScoreImage = {
    imageId: string;
    /** The cluster the image belongs to (ADR 0006) — the org page's Cluster column. */
    clusterId: string;
    clusterName: string;
    registry: string | null;
    repository: string | null;
    digest: string;
    /**
     * Distinct tags the cluster's deployments asked for, sorted. Tags live on
     * `workload_containers`, not `images` — a digest may carry several, and a
     * digest-pinned deployment none — so this is the display name's best
     * effort, never part of identity.
     */
    tags: string[];
    /** Who controls the image (`lib/image-control.ts`). */
    control: "built" | "third-party" | "unknown";
    /** Sum of the image's finding contributions — its share of the cluster total. */
    score: number;
    /** Band of the image's worst finding (never a threshold on the sum). */
    band: RiskBand;
    findingCount: number;
    kevCount: number;
    /** The worst finding — rank 1 in the sum. */
    topFinding: { vulnId: string; risk: number } | null;
    /** Workloads running this image, namespace-qualified; empty when scanned but not inventoried. */
    workloads: {
        containerId: string;
        namespaceName: string;
        workloadName: string;
        workloadKind: string | null;
    }[];
};

/**
 * One finding, with where it runs — the row unit of the Dashboard's "Start
 * here" block, which lists the handful of findings across every cluster
 * that move the org's Radar Score most.
 *
 * Finding-level rather than advisory-level (the Vulnerabilities list) or
 * image-level (the breakdown): "fix this package in this image" is the unit
 * of work, and the image link is where the upgrade recommendation lives.
 */
export type TopFinding = ClusterRadarScoreFinding & {
    /** On CISA KEV, or EPSS at or above `NOTABLE_EPSS` — sorted first. */
    exploited: boolean;
    imageId: string;
    registry: string | null;
    repository: string | null;
    digest: string;
    /** Distinct tags the deployments asked for, sorted. */
    tags: string[];
    clusterId: string;
    clusterName: string;
    /** Distinct workloads running the image; 0 when scanned but not inventoried. */
    workloadCount: number;
    /** Distinct running containers on the image; 0 under the same condition. */
    containerCount: number;
};

/** `?control=` on the Radar Score image list. `yours` includes the images nothing has decided. */
export type ControlFilter = "yours" | "third-party";

/**
 * The Radar Score, partitioned by who controls the image — the same sum, not
 * a second score. `yours` is `total − upstream` rather than its own rounded
 * sum, so the two always add up to the headline. There is deliberately no
 * third bucket: an unconfirmed image counts as yours (recommendations treat
 * it that way too), and `unconfirmedImages` says how many there are.
 */
export type RadarScoreByControl = { yours: number; upstream: number; unconfirmedImages: number };

export type ClusterRadarScorePage = {
    images: ClusterRadarScoreImage[];
    /**
     * The scope's Radar Score — the sum of every image's `score`. Never
     * narrowed by `?control=`: the filter chooses rows, the headline stays.
     */
    total: number;
    byControl: RadarScoreByControl;
    /** Images with at least one finding — what pagination pages over. */
    imageCount: number;
    findingCount: number;
    limit: number;
    offset: number;
};

/**
 * One finding's contribution to an image's score — the expand-row unit.
 *
 * Sorted by contribution, so the first rows explain most of the number. Every
 * input the formula uses is carried so the number can be argued with; the
 * score itself is read from the generated column, never recomputed.
 */
export type ClusterRadarScoreFinding = {
    vulnId: string;
    summary: string | null;
    packageName: string;
    packageVersion: string | null;
    severity: "critical" | "high" | "medium" | "low" | null;
    /** The contribution, 0–100. */
    riskScore: number | null;
    cvssScore: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: Date | null;
    kevDueDate: Date | null;
    kevRansomware: string | null;
    fixedVersion: string | null;
    /** Outside the requested tier lens, listed because it is exploited. */
    shownDespiteTier: boolean;
};

/** A findings list with the per-bucket counts of the same set, unlensed. */
export type LensedFindings<T> = { findings: T[]; tierCounts: TierCounts };

async function tierCountsOver(findings: ReturnType<typeof collapsedFindings>): Promise<TierCounts> {
    const [row] = await db.select(tierCountColumns(findings)).from(findings);
    return row
        ? { application: Number(row.application), base: Number(row.base), all: Number(row.all) }
        : emptyTierCounts();
}

const SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;

function normaliseSeverity(level: string | null): ClusterRadarScoreFinding["severity"] {
    const lowered = level?.toLowerCase() ?? "";
    return (SEVERITY_LEVELS as readonly string[]).includes(lowered)
        ? (lowered as ClusterRadarScoreFinding["severity"])
        : null;
}

export const radarScoreRepository = {
    /**
     * Every image in scope carrying at least one finding, highest score
     * first. Same population as `clusterRiskScores` / `orgRiskRollup` in
     * `db/risk.ts`, so `total` here equals the Overview's (or, org-scoped,
     * the Dashboard's) current Radar Score.
     */
    async findImages(
        scope: FindingScope,
        options: { limit?: number | undefined; offset?: number | undefined; control?: ControlFilter | undefined } = {},
    ): Promise<ClusterRadarScorePage> {
        const limit = Math.min(options.limit ?? 50, 200);
        const offset = options.offset ?? 0;
        const controlWhere =
            options.control === "third-party"
                ? eq(schema.images.control, "third-party")
                : options.control === "yours"
                  ? ne(schema.images.control, "third-party")
                  : undefined;

        const findings = collapsedFindings(deployedImagesIn(scope));

        // `risk_score` is the generated column's name, which the subquery
        // keeps; the aggregate is the one `risk-model.ts` defines, not a local sum.
        const scoreAgg = sql<number>`${sql.raw(aggregateRiskSql(`"findings"."risk_score"`))}`;
        const topRiskAgg = sql<number | null>`max(${findings.riskScore})`;

        const perImage = db
            .select({
                imageId: findings.imageId,
                score: scoreAgg.as("score"),
                findingCount: sql<number>`count(*)::int`.as("finding_count"),
                kevCount: sql<number>`count(*) FILTER (WHERE ${findings.kevListedAt} IS NOT NULL)::int`.as("kev_count"),
                topVulnId: sql<
                    string | null
                >`(array_agg(${findings.vulnId} ORDER BY ${findings.riskScore} DESC NULLS LAST, ${findings.vulnId}))[1]`.as(
                    "top_vuln_id",
                ),
                topRisk: topRiskAgg.as("top_risk"),
            })
            .from(findings)
            .groupBy(findings.imageId)
            .as("per_image");

        const [rows, totalsRows] = await Promise.all([
            db
                .select({
                    imageId: perImage.imageId,
                    clusterId: schema.images.clusterId,
                    clusterName: schema.clusters.name,
                    registry: schema.images.registry,
                    repository: schema.images.repository,
                    digest: schema.images.digest,
                    control: schema.images.control,
                    score: perImage.score,
                    findingCount: perImage.findingCount,
                    kevCount: perImage.kevCount,
                    topVulnId: perImage.topVulnId,
                    topRisk: perImage.topRisk,
                })
                .from(perImage)
                .innerJoin(schema.images, eq(schema.images.id, perImage.imageId))
                .innerJoin(schema.clusters, eq(schema.clusters.id, schema.images.clusterId))
                .where(controlWhere)
                .orderBy(
                    desc(perImage.score),
                    sql`${perImage.topRisk} DESC NULLS LAST`,
                    asc(schema.images.repository),
                    asc(schema.images.digest),
                )
                .limit(limit)
                .offset(offset),
            // The total is the same fold `clusterRiskScores` does — one rounding
            // over the whole cluster — not a sum of the already-rounded rows, so
            // the headline here is exactly the number on the Overview chart.
            db
                .select({
                    total: sql<number | null>`${sql.raw(aggregateRiskSql(`"findings"."risk_score"`))}`,
                    upstream: sql<
                        number | null
                    >`round(sum(${findings.riskScore}) FILTER (WHERE ${schema.images.control} = 'third-party'))::int`,
                    unconfirmedImages: sql<number>`count(DISTINCT ${findings.imageId}) FILTER (WHERE ${schema.images.control} = 'unknown')::int`,
                    // What the list pages over: narrowed by `?control=`, unlike `total`.
                    imageCount: controlWhere
                        ? sql<number>`count(DISTINCT ${findings.imageId}) FILTER (WHERE ${controlWhere})::int`
                        : sql<number>`count(DISTINCT ${findings.imageId})::int`,
                    findingCount: controlWhere
                        ? sql<number>`count(*) FILTER (WHERE ${controlWhere})::int`
                        : sql<number>`count(*)::int`,
                })
                .from(findings)
                .innerJoin(schema.images, eq(schema.images.id, findings.imageId)),
        ]);

        // The workloads of the page's images only — a second small query
        // rather than a jsonb_agg on the main one, which would have to be
        // DISTINCT'd against the finding fan-out.
        const imageIds = rows.map((r) => r.imageId);
        const workloadRows =
            imageIds.length === 0
                ? []
                : await db
                      .select({
                          imageId: schema.workloadContainers.imageId,
                          containerId: sql<string>`min(${schema.workloadContainers.id}::text)`,
                          tags: sql<
                              string[]
                          >`array_remove(array_agg(DISTINCT ${schema.workloadContainers.imageTag}), NULL)`,
                          workloadName: schema.workloads.name,
                          workloadKind: schema.workloads.kind,
                          namespaceName: schema.namespaces.name,
                      })
                      .from(schema.workloadContainers)
                      .innerJoin(schema.workloads, eq(schema.workloads.id, schema.workloadContainers.workloadId))
                      .innerJoin(schema.namespaces, eq(schema.namespaces.id, schema.workloads.namespaceId))
                      .where(inArray(schema.workloadContainers.imageId, imageIds))
                      .groupBy(
                          schema.workloadContainers.imageId,
                          schema.workloads.id,
                          schema.workloads.name,
                          schema.workloads.kind,
                          schema.namespaces.name,
                      )
                      .orderBy(asc(schema.namespaces.name), asc(schema.workloads.name));

        const workloadsByImage = new Map<string, ClusterRadarScoreImage["workloads"]>();
        const tagsByImage = new Map<string, Set<string>>();
        for (const w of workloadRows) {
            const tags = tagsByImage.get(w.imageId) ?? new Set<string>();
            for (const tag of w.tags) tags.add(tag);
            tagsByImage.set(w.imageId, tags);
            const list = workloadsByImage.get(w.imageId) ?? [];
            list.push({
                containerId: w.containerId,
                namespaceName: w.namespaceName,
                workloadName: w.workloadName,
                workloadKind: w.workloadKind,
            });
            workloadsByImage.set(w.imageId, list);
        }

        const totals = totalsRows[0];
        return {
            images: rows.map((row) => {
                const topRisk = row.topRisk == null ? 0 : Number(row.topRisk);
                return {
                    imageId: row.imageId,
                    clusterId: row.clusterId,
                    clusterName: row.clusterName,
                    registry: row.registry,
                    repository: row.repository,
                    digest: row.digest,
                    tags: [...(tagsByImage.get(row.imageId) ?? [])].sort(),
                    control: row.control,
                    score: row.score == null ? 0 : Number(row.score),
                    band: riskBand(topRisk),
                    findingCount: Number(row.findingCount),
                    kevCount: Number(row.kevCount),
                    topFinding: row.topVulnId == null ? null : { vulnId: row.topVulnId, risk: topRisk },
                    workloads: workloadsByImage.get(row.imageId) ?? [],
                };
            }),
            total: Number(totals?.total ?? 0),
            byControl: {
                upstream: Number(totals?.upstream ?? 0),
                yours: Number(totals?.total ?? 0) - Number(totals?.upstream ?? 0),
                unconfirmedImages: Number(totals?.unconfirmedImages ?? 0),
            },
            imageCount: Number(totals?.imageCount ?? 0),
            findingCount: Number(totals?.findingCount ?? 0),
            limit,
            offset,
        };
    },

    /**
     * Every finding of one image in scope, largest contribution first — the
     * rows that add up to that image's `score`. The scope is kept on the
     * query (not just the owned-cluster check on the route) so an image id
     * from another cluster of the same org — or another org — returns nothing.
     */
    async findImageFindings(
        scope: FindingScope,
        imageId: string,
        tiers?: TierLens,
    ): Promise<LensedFindings<ClusterRadarScoreFinding>> {
        const findings = collapsedFindings(and(deployedImagesIn(scope), eq(schema.images.id, imageId))!);

        const tierCountsPromise = tierCountsOver(findings);
        const rows = await db
            .select({
                shownDespiteTier: shownDespiteTierSql(findings, tiers),
                vulnId: findings.vulnId,
                summary: schema.vulnerabilities.summary,
                packageName: findings.packageName,
                packageVersion: findings.packageVersion,
                severityLevel: findings.severityLevel,
                riskScore: findings.riskScore,
                cvssScore: schema.vulnerabilities.cvssScore,
                epssScore: findings.epssScore,
                epssPercentile: schema.vulnerabilities.epssPercentile,
                kevListedAt: findings.kevListedAt,
                kevDueDate: findings.kevDueDate,
                kevRansomware: findings.kevRansomware,
                fixedVersion: findings.fixedVersion,
            })
            .from(findings)
            .innerJoin(schema.vulnerabilities, eq(schema.vulnerabilities.vulnId, findings.vulnId))
            .where(inTierLens(findings, tiers))
            .orderBy(sql`${findings.riskScore} DESC NULLS LAST`, asc(findings.vulnId), asc(findings.packageName));

        const mapped = rows.map((row) => ({
            vulnId: row.vulnId,
            summary: row.summary,
            packageName: row.packageName,
            packageVersion: row.packageVersion,
            severity: normaliseSeverity(row.severityLevel),
            riskScore: row.riskScore == null ? null : Number(row.riskScore),
            cvssScore: row.cvssScore == null ? null : Number(row.cvssScore),
            epssScore: row.epssScore == null ? null : Number(row.epssScore),
            epssPercentile: row.epssPercentile == null ? null : Number(row.epssPercentile),
            kevListedAt: row.kevListedAt,
            kevDueDate: row.kevDueDate,
            kevRansomware: row.kevRansomware,
            fixedVersion: row.fixedVersion,
            shownDespiteTier: row.shownDespiteTier === true,
        }));
        return { findings: mapped, tierCounts: await tierCountsPromise };
    },

    /**
     * The N findings in scope that most deserve attention: exploited ones
     * first (KEV, or EPSS ≥ `NOTABLE_EPSS`), then by contribution — the same
     * rule the Vulnerabilities lists sort by, at finding grain and with the
     * image and cluster each one runs in. The weekly digest's "Start here"
     * rows read it (`cloud/alerting/digest.service.ts`); it has no route.
     *
     * One row per collapsed finding, so an image with ten exploited findings
     * can fill the list — that is honest: those are the ten largest terms of
     * the sum, and they share one upgrade.
     */
    async findTopFindings(
        scope: FindingScope,
        limit: number,
        tiers?: TierLens,
        control?: ControlFilter,
    ): Promise<LensedFindings<TopFinding>> {
        // `yours` leaves out third-party images: a finding there has one
        // action, the upstream upgrade, and that is a line, not a row.
        const controlScope =
            control === "third-party"
                ? eq(schema.images.control, "third-party")
                : control === "yours"
                  ? ne(schema.images.control, "third-party")
                  : undefined;
        const findings = collapsedFindings(and(deployedImagesIn(scope), controlScope)!);
        const tierCountsPromise = tierCountsOver(findings);
        const exploited = sql<boolean>`(${findings.kevListedAt} IS NOT NULL OR ${findings.epssScore} >= ${NOTABLE_EPSS})`;

        const rows = await db
            .select({
                vulnId: findings.vulnId,
                summary: schema.vulnerabilities.summary,
                packageName: findings.packageName,
                packageVersion: findings.packageVersion,
                severityLevel: findings.severityLevel,
                riskScore: findings.riskScore,
                cvssScore: schema.vulnerabilities.cvssScore,
                epssScore: findings.epssScore,
                epssPercentile: schema.vulnerabilities.epssPercentile,
                kevListedAt: findings.kevListedAt,
                kevDueDate: findings.kevDueDate,
                kevRansomware: findings.kevRansomware,
                fixedVersion: findings.fixedVersion,
                shownDespiteTier: shownDespiteTierSql(findings, tiers),
                exploited,
                imageId: findings.imageId,
                registry: schema.images.registry,
                repository: schema.images.repository,
                digest: schema.images.digest,
                clusterId: schema.images.clusterId,
                clusterName: schema.clusters.name,
                /* Correlated rather than joined: joining `workload_containers`
                   would multiply every finding by the places its image runs
                   (the trap `db/findings.ts` documents). */
                workloadCount: sql<number>`(
                    SELECT count(DISTINCT wc.workload_id)
                    FROM workload_containers wc
                    WHERE wc.image_id = ${findings.imageId}
                )::int`,
                containerCount: sql<number>`(
                    SELECT count(*)
                    FROM workload_containers wc
                    WHERE wc.image_id = ${findings.imageId}
                )::int`,
                tags: sql<string[]>`(
                    SELECT coalesce(array_agg(DISTINCT wc.image_tag ORDER BY wc.image_tag) FILTER (WHERE wc.image_tag IS NOT NULL), '{}')
                    FROM workload_containers wc
                    WHERE wc.image_id = ${findings.imageId}
                )`,
            })
            .from(findings)
            .innerJoin(schema.vulnerabilities, eq(schema.vulnerabilities.vulnId, findings.vulnId))
            .innerJoin(schema.images, eq(schema.images.id, findings.imageId))
            .innerJoin(schema.clusters, eq(schema.clusters.id, schema.images.clusterId))
            .where(inTierLens(findings, tiers))
            .orderBy(
                sql`${exploited} DESC`,
                sql`${findings.riskScore} DESC NULLS LAST`,
                asc(findings.vulnId),
                asc(findings.packageName),
                asc(schema.images.digest),
            )
            .limit(Math.min(Math.max(limit, 1), 50));

        const mapped = rows.map((row) => ({
            vulnId: row.vulnId,
            summary: row.summary,
            packageName: row.packageName,
            packageVersion: row.packageVersion,
            severity: normaliseSeverity(row.severityLevel),
            riskScore: row.riskScore == null ? null : Number(row.riskScore),
            cvssScore: row.cvssScore == null ? null : Number(row.cvssScore),
            epssScore: row.epssScore == null ? null : Number(row.epssScore),
            epssPercentile: row.epssPercentile == null ? null : Number(row.epssPercentile),
            kevListedAt: row.kevListedAt,
            kevDueDate: row.kevDueDate,
            kevRansomware: row.kevRansomware,
            fixedVersion: row.fixedVersion,
            shownDespiteTier: row.shownDespiteTier === true,
            exploited: row.exploited === true,
            imageId: row.imageId,
            registry: row.registry,
            repository: row.repository,
            digest: row.digest,
            tags: row.tags ?? [],
            clusterId: row.clusterId,
            clusterName: row.clusterName,
            workloadCount: Number(row.workloadCount),
            containerCount: Number(row.containerCount),
        }));
        return { findings: mapped, tierCounts: await tierCountsPromise };
    },
};
