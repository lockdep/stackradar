import {
    componentRepository,
    imageLayerRepository,
    jobRepository,
    sbomRepository,
    vulnerabilityRepository,
} from "../repositories/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import {
    computeVulnScanStatus,
    emptyBucketCounts,
    groupVulnerabilities,
    toResponseGroups,
} from "./vulnerability-grouping.service.js";

import { applyTierLens, tierCountsOf, type TierLens } from "../db/finding-tier.js";

const log = createLogger("grouped-findings");

/** The hover shows the instruction and enough to recognise it, not the whole line. */
const LAYER_LINE_MAX = 120;

/**
 * What the pod spec asked for, when the caller is looking through a container.
 *
 * An SBOM describes bytes and carries no tag or ref, so these come off the
 * container rather than the document. The image page has no single container
 * to read them from — a digest may run under several tags — and passes `null`.
 */
export type DeploymentFacts = { imageTag: string | null; imageRef: string | null };

/**
 * An image's findings, grouped by component, with the freshness facts the
 * Vulnerabilities table renders above them.
 *
 * One function behind two routes. Findings belong to the image
 * (ADR 0004), so the workload page and the image page show the same table;
 * the container is only how the workload page names the image.
 *
 * `tiers` is the tier lens (`?tier=`). `tierCounts` is always computed over
 * the unlensed findings, so the folded bucket keeps its number; `summary` and
 * `groups` describe what the lens shows.
 */
export async function loadGroupedFindings(
    imageId: string,
    deployment: DeploymentFacts | null,
    tiers?: TierLens
) {
    const sbom = await sbomRepository.findByImageId(imageId);

    const time = createQueryTimer(log, { imageId });
    const [allVulnerabilities, componentMetas, deps, latestVulnScanJob] = await Promise.all([
        time("findBySbomId", sbom ? vulnerabilityRepository.findBySbomId(sbom.id) : Promise.resolve([])),
        time("findLeanMetaBySbomId", sbom ? componentRepository.findLeanMetaBySbomId(sbom.id) : Promise.resolve([])),
        time("getAllDependenciesBySbomId", sbom ? sbomRepository.getAllDependenciesBySbomId(sbom.id) : Promise.resolve([])),
        time("findLatestVulnScanForImage", jobRepository.findLatestVulnScanForImage(imageId)),
    ]);

    const hasDependencies = componentMetas.length > 0;

    const withTier = allVulnerabilities.map((v) => ({ ...v, tier: v.componentTier, fromBase: v.componentFromBase }));
    const tierCounts = tierCountsOf(withTier);
    const vulnerabilities = tiers ? applyTierLens(withTier, tiers) : withTier;

    const currentSbom = sbom
        ? {
            id: sbom.id,
            createdAt: sbom.createdAt.toISOString(),
            format: sbom.format,
            specVersion: sbom.specVersion,
            imageTag: deployment?.imageTag ?? null,
            imageRef: deployment?.imageRef ?? null,
            toolName: sbom.toolName,
            toolVersion: sbom.toolVersion,
            sbomSha256: sbom.sbomSha256,
            documentVersion: sbom.documentVersion,
            componentCount: componentMetas.length,
        }
        : null;

    const vulnScan = {
        status: computeVulnScanStatus(latestVulnScanJob, sbom),
        completedAt: latestVulnScanJob?.completedAt?.toISOString() ?? null,
        jobId: latestVulnScanJob?.id ?? null,
    };

    if (vulnerabilities.length === 0) {
        return {
            summary: { ...emptyBucketCounts(), total: 0 },
            hasDependencies,
            groups: [],
            tierCounts,
            currentSbom,
            vulnScan,
        };
    }

    const { summary, groups } = groupVulnerabilities(vulnerabilities, componentMetas, deps);

    // The Dockerfile line behind each package's layer — the hover on a finding.
    // One small read per image, and only when some component knows its layer.
    const layers = groups.some((g) => g.layerIndex !== null) ? await imageLayerRepository.findByImageId(imageId) : [];
    const createdByLayer = new Map(layers.filter((l) => l.rootfsIndex !== null).map((l) => [l.rootfsIndex!, l.createdBy]));
    for (const group of groups) {
        const line = group.layerIndex === null ? null : (createdByLayer.get(group.layerIndex) ?? null);
        group.layerCreatedBy = line ? line.slice(0, LAYER_LINE_MAX) : null;
    }

    return {
        summary,
        hasDependencies,
        groups: toResponseGroups(groups),
        tierCounts,
        currentSbom,
        vulnScan,
    };
}
