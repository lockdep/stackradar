/**
 * Risk, rolled up to the things a person looks at.
 *
 * `risk-model.ts` defines the formula and argues for its shape. `findings.ts`
 * defines what is counted. This module is the join between them: it takes the
 * findings of an image, a workload or a release and sums their advisory risks
 * into one number for that row — the unbounded total ADR 0007 describes.
 *
 * The sum **composes**: a cluster's total really is the sum of its images'
 * totals, because every finding contributes the same amount whichever group it
 * is counted in. The functions here still each fold from raw findings rather
 * than from each other — one query beats N — but composition is now a property
 * callers may rely on, where under the old rank-decayed fold it was the bug the
 * module header warned about.
 *
 * ## Why the distinct step is not optional
 *
 * A workload legitimately runs the same digest twice — an init container that
 * seeds a volume from the image the main container serves from — and
 * mid-rollout it runs two digests under one container name. Joining
 * `workload_containers` to findings without a `DISTINCT` counts some findings
 * twice, inflating the score of exactly the workloads that are hardest to
 * reason about. Same argument as `deployedImages` in `findings.ts`: the join
 * multiplies, so the query has to un-multiply.
 */

import { eq, inArray, sql, type SQL, type Subquery } from "drizzle-orm";
import { db } from "./index.js";
import { collapsedFindings, deployedImages, deployedImagesInClusters } from "./findings.js";
import { images } from "./schema/images.js";
import { EXPLOITED_EPSS } from "./finding-tier.js";
import { workloadContainers } from "./schema/workload-containers.js";
import { workloads } from "./schema/workloads.js";
import { aggregateRiskSql, riskBand, type RiskBand } from "./risk-model.js";

/**
 * One row's risk, and enough of its working to render "why".
 *
 * Everything here except `score` exists because of the acceptance criterion
 * that every ranked row expose its inputs. A score with no explanation is what
 * risk-ranking.md warns undoes the product's credibility, so the shape that
 * makes explanation impossible is not offered.
 */
export interface RiskRollup {
    /**
     * Unbounded sum of the group's finding risks — a magnitude, not a
     * ranking. See `risk-model.ts` and ADR 0007 for what the number means.
     */
    score: number;
    /**
     * The band of the group's **worst finding**, not of the total. Colour
     * answers "how bad is the worst thing in here"; the score answers "how
     * much is there". Banding the unbounded sum would paint every large group
     * critical regardless of what is in it.
     */
    band: RiskBand;
    /** Findings folded into the score. */
    findingCount: number;
    /** How many sit on CISA's KEV catalogue — a badge, not a number. */
    kevCount: number;
    /**
     * Findings with an EPSS score at or above {@link NOTABLE_EPSS}. The middle
     * state between "CISA has confirmed exploitation" and "nothing is known",
     * and the honest way to say "this is being exploited somewhere" without
     * attributing it to CISA.
     */
    exploitedCount: number;
    /** The advisory driving the score — rank 1 in the fold. */
    topFinding: { vulnId: string; risk: number } | null;
}

/**
 * The EPSS score above which a finding is called out as under active
 * exploitation pressure.
 *
 * 0.1 — a one-in-ten chance of exploitation within thirty days — is around the
 * 90th percentile of the EPSS corpus, so this labels roughly the top tenth
 * rather than a fixed count. It is a **display** threshold and appears nowhere
 * in the score: the score already weights EPSS continuously, and a cliff in it
 * would push two findings either side of 0.1 further apart than their
 * probabilities justify.
 */
export const NOTABLE_EPSS = EXPLOITED_EPSS;

/** A row with no findings scores 0 — which is not the same as "not scanned". */
export function emptyRiskRollup(): RiskRollup {
    return {
        score: 0,
        band: "none",
        findingCount: 0,
        kevCount: 0,
        exploitedCount: 0,
        topFinding: null,
    };
}

/**
 * The columns {@link foldOver} needs, whatever subquery produced them.
 *
 * A structural contract rather than a shared builder because the callers below
 * reach their findings through genuinely different joins — an image needs
 * none, a workload one, a release two — and the only thing they can agree on
 * is what comes out.
 */
type RankedFindings = {
    /** The row being scored: image id, workload id, release id. */
    key: SQL.Aliased<string>;
    vulnId: SQL.Aliased<string>;
    risk: SQL.Aliased<number>;
    kevListedAt: SQL.Aliased<Date | null>;
    epssScore: SQL.Aliased<number | null>;
};

/** Project a `collapsedFindings` row into the shape {@link foldOver} folds. */
function riskColumns(findings: ReturnType<typeof collapsedFindings>) {
    return {
        vulnId: sql<string>`${findings.vulnId}`.as("vuln_id"),
        risk: sql<number>`${findings.riskScore}`.as("risk"),
        kevListedAt: sql<Date | null>`${findings.kevListedAt}`.as("kev_listed_at"),
        epssScore: sql<number | null>`${findings.epssScore}`.as("epss_score"),
    };
}

/**
 * The shared last step: group by key, sum the risks, keep the working.
 *
 * `(array_agg(vuln_id ORDER BY risk DESC NULLS LAST, vuln_id))[1]` rather than
 * a second query for the top finding: same scan, and the `vuln_id` tie-break
 * makes the advisory named deterministic when two findings carry identical
 * risk — on a base image full of unscored advisories that is the common case
 * rather than a curiosity.
 *
 * The rollup's band is the band of that worst finding, not of the total; see
 * {@link RiskRollup.band}.
 */
async function foldOver(ranked: Subquery<"ranked", RankedFindings> & RankedFindings): Promise<Map<string, RiskRollup>> {
    const rows = await db
        .select({
            key: sql<string>`${ranked.key}`.as("key"),
            score: sql<number>`${sql.raw(aggregateRiskSql(`"ranked"."risk"`))}`,
            findingCount: sql<number>`count(*)::int`,
            kevCount: sql<number>`count(*) FILTER (WHERE ${ranked.kevListedAt} IS NOT NULL)::int`,
            exploitedCount: sql<number>`count(*) FILTER (WHERE ${ranked.epssScore} >= ${NOTABLE_EPSS})::int`,
            topVulnId: sql<
                string | null
            >`(array_agg(${ranked.vulnId} ORDER BY ${ranked.risk} DESC NULLS LAST, ${ranked.vulnId}))[1]`,
            topRisk: sql<number | null>`max(${ranked.risk})`,
        })
        .from(ranked)
        .groupBy(ranked.key);

    const out = new Map<string, RiskRollup>();
    for (const row of rows) {
        const topRisk = row.topRisk == null ? 0 : Number(row.topRisk);
        out.set(row.key, {
            score: row.score == null ? 0 : Number(row.score),
            band: riskBand(topRisk),
            findingCount: row.findingCount,
            kevCount: row.kevCount,
            exploitedCount: row.exploitedCount,
            topFinding: row.topVulnId == null ? null : { vulnId: row.topVulnId, risk: topRisk },
        });
    }
    return out;
}

/**
 * Risk per image. The base case — a finding already keys on an image, so there
 * is no join and nothing to un-multiply.
 */
export async function imageRiskScores(imageIds: string[]): Promise<Map<string, RiskRollup>> {
    if (imageIds.length === 0) return new Map();

    const findings = collapsedFindings(inArray(images.id, imageIds));
    const ranked = db
        .select({
            key: sql<string>`${findings.imageId}`.as("key"),
            ...riskColumns(findings),
        })
        .from(findings)
        .as("ranked");

    return foldOver(ranked);
}

/**
 * Risk per workload — the number the workloads list ranks by.
 *
 * The `selectDistinct` is the un-multiply step from the module header. Its
 * selection is exactly the identity of a finding within a workload —
 * `(workload, component, advisory)` — so a digest mounted twice contributes its
 * findings once.
 */
export async function workloadRiskScores(workloadIds: string[]): Promise<Map<string, RiskRollup>> {
    if (workloadIds.length === 0) return new Map();

    const imageScope = db
        .select({ id: workloadContainers.imageId })
        .from(workloadContainers)
        .where(inArray(workloadContainers.workloadId, workloadIds));

    const findings = collapsedFindings(inArray(images.id, imageScope));
    const ranked = db
        .selectDistinct({
            key: sql<string>`${workloadContainers.workloadId}`.as("key"),
            componentId: sql<string>`${findings.componentId}`.as("component_id"),
            ...riskColumns(findings),
        })
        .from(findings)
        .innerJoin(workloadContainers, eq(workloadContainers.imageId, findings.imageId))
        .where(inArray(workloadContainers.workloadId, workloadIds))
        .as("ranked");

    return foldOver(ranked);
}

/**
 * Risk per Helm release — every workload the chart deploys, including the ones
 * that landed in another namespace.
 *
 * The release is a property of the *workload* (`workloads.release_id`), not of
 * the container, so this walks one table further than the workload version
 * rather than reusing it.
 */
export async function releaseRiskScores(releaseIds: string[]): Promise<Map<string, RiskRollup>> {
    if (releaseIds.length === 0) return new Map();

    const imageScope = db
        .select({ id: workloadContainers.imageId })
        .from(workloadContainers)
        .innerJoin(workloads, eq(workloadContainers.workloadId, workloads.id))
        .where(inArray(workloads.releaseId, releaseIds));

    const findings = collapsedFindings(inArray(images.id, imageScope));
    const ranked = db
        .selectDistinct({
            key: sql<string>`${workloads.releaseId}`.as("key"),
            componentId: sql<string>`${findings.componentId}`.as("component_id"),
            ...riskColumns(findings),
        })
        .from(findings)
        .innerJoin(workloadContainers, eq(workloadContainers.imageId, findings.imageId))
        .innerJoin(workloads, eq(workloadContainers.workloadId, workloads.id))
        .where(inArray(workloads.releaseId, releaseIds))
        .as("ranked");

    return foldOver(ranked);
}

/**
 * Risk per cluster — the Clusters list and the cluster Overview number.
 *
 * Under ADR 0006 an image belongs to exactly one cluster, so a finding does
 * too: the key is `images.cluster_id` and there is nothing to un-multiply.
 * Scoped by `deployedImagesInClusters` — the deployed-or-new rule every other
 * cluster surface applies — so this total, the Risk Score tab's headline and
 * the cluster's finding counts all describe one population. Without it,
 * digests that stopped running but sit in GC retention kept contributing,
 * and the Overview read more than double the Risk Score tab.
 */
export async function clusterRiskScores(clusterIds: string[]): Promise<Map<string, RiskRollup>> {
    if (clusterIds.length === 0) return new Map();

    const findings = collapsedFindings(deployedImagesInClusters(clusterIds));
    const ranked = db
        .select({
            key: sql<string>`${images.clusterId}`.as("key"),
            ...riskColumns(findings),
        })
        .from(findings)
        .innerJoin(images, eq(images.id, findings.imageId))
        .as("ranked");

    return foldOver(ranked);
}

/**
 * One number for the whole org — the Dashboard's headline total.
 *
 * Because the aggregate is a sum, this equals the sum of the org's cluster
 * totals; it is still folded from raw findings here so it is one query and one
 * definition, not client-side arithmetic over another endpoint's output.
 */
export async function orgRiskRollup(orgId: string): Promise<RiskRollup> {
    const findings = collapsedFindings(deployedImages(orgId));
    const ranked = db
        .select({
            key: sql<string>`${images.orgId}`.as("key"),
            ...riskColumns(findings),
        })
        .from(findings)
        .innerJoin(images, eq(images.id, findings.imageId))
        .as("ranked");

    const folded = await foldOver(ranked);
    return folded.get(orgId) ?? emptyRiskRollup();
}
