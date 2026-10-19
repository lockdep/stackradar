import type { RiskBand, RiskRollup } from '@/lib/risk';
import type { TierCounts } from '@/lib/tier-lens';
import type { ImageControl } from '@/lib/image-control';

export type Cluster = {
    id: string;
    name: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
    /**
     * True when the cluster currently has an active API key. Drives UI affordances
     * that differ for first-time setup vs. rotation (e.g. revocation warnings).
     */
    hasApiKey: boolean;
    /**
     * Helm chart version last reported by the in-cluster scanner via the
     * `X-Scanner-Version` request header, or `null` if the scanner has never
     * checked in (legacy agent, or not yet installed). Used to flag clusters
     * running an outdated agent.
     */
    scannerVersion: string | null;
    /**
     * Timestamp of the last authenticated request from this cluster's scanner.
     * `null` if the scanner has never checked in.
     */
    scannerLastSeenAt: string | null;
    /**
     * The cluster's Kubernetes `gitVersion` (e.g. `v1.29.4+k3s1`), reported by
     * the scanner via the `X-Kubernetes-Version` heartbeat header. `null` means
     * "unknown" — an older scanner, or one whose `/version` read failed —
     * never "no version".
     */
    kubernetesVersion: string | null;
    /**
     * How many workloads the scanner's informer can currently see in this
     * cluster, reported ahead of any SBOM for them.
     *
     * `null` — not `0` — when the cluster has never sent an inventory report,
     * which is the normal state for a scanner older than the feature. Treat
     * null as "unknown", never as "empty cluster".
     */
    discoveredWorkloads: number | null;
    /**
     * How many of those discovered workloads have an SBOM.
     *
     * Counted from the same `LEFT JOIN` as `discoveredWorkloads` — running
     * containers left-joined to their image's SBOM — so it is a subset by
     * construction and the two are safe to render as a ratio. A container whose
     * been deleted from the cluster is deliberately not counted here; it is
     * still a workload you have data on, just not one that is running.
     *
     * `null` under exactly the same condition as `discoveredWorkloads`.
     */
    scannedWorkloads: number | null;
    /** When that inventory was last reported, or `null` if it never was. */
    inventoryReportedAt: string | null;
    /**
     * Distinct registry hosts the scanner could not authenticate to, over the
     * cluster's workloads that still have no SBOM. Always an array — empty when
     * nothing is blocked on credentials, including for a cluster that has
     * never reported. Drives the Dashboard's registry-auth banner; the cluster
     * page's Coverage card carries the per-workload rows and the fix.
     */
    registryAuthFailedHosts: string[];
    /** Running containers without an SBOM whose last scan failed on registry auth. */
    registryAuthFailedWorkloads: number;
    /**
     * Whether the last inventory report could read its workloads' controllers.
     *
     * `null` until a report arrives; `false` when the agent was not permitted to
     * read Deployments and StatefulSets, or has the lookup switched off.
     *
     * Treat `false` as "we could not look", never as "nothing is chart-managed".
     * Helm and ArgoCD record their context on the controller, not on the pod, so
     * without that read a chart-managed workload is indistinguishable from an
     * unmanaged one — and the unmanaged bucket has to say so rather than assert
     * something it cannot support.
     */
    ownerMetadataCollected: boolean | null;
    /**
     * The cluster's total risk: the unbounded sum of every deployed image's
     * finding risks (ADR 0007), with the worst finding's band and the KEV
     * count riding along. `emptyRiskRollup()` — score 0, band "none" — for a
     * cluster with nothing scanned yet; the rollup itself is never null here.
     */
    risk: RiskRollup;
};

/** One running container the scanner can see that has no SBOM yet. */
type UnscannedContainer = {
    namespace: string;
    workloadName: string;
    /**
     * PascalCase Kubernetes kind (`Deployment`, `CronJob`, …), or `null` when
     * the scanner could not resolve the pod's owner. Never guess one.
     */
    workloadKind: string | null;
    containerName: string;
    imageRef: string;
    imageDigest: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    /**
     * Why the image has no SBOM, when the scanner has said — its stderr
     * classification off the inventory report. All three null while a scan is
     * simply still in flight. `scanErrorCode` is an open set
     * (`registry_auth` | `registry_rate_limited` | `scan_error` today):
     * render anything unrecognised as a generic scan failure, never as one of
     * the specific states.
     */
    scanErrorCode: string | null;
    scanErrorHost: string | null;
    scanErrorAt: string | null;
    /**
     * Names of the pull Secrets on the pods running this container, as the
     * scanner reported them — never contents. `null` when the scanner did
     * not say (older than the field); `[]` when the pods carry none. The
     * registry-auth remediation pre-fills `scanner.imagePullSecretNames`
     * from these, and must treat the two empties differently.
     */
    imagePullSecrets: string[] | null;
};

/** Response of `GET /api/clusters/:id/coverage`. */
export type ClusterCoverage = {
    /** `null` when the cluster has never reported an inventory. */
    discovered: number | null;
    scanned: number | null;
    reportedAt: string | null;
    workloads: UnscannedContainer[];
};

/**
 * One distinct package (name + version) running in a cluster. The same
 * package inside thirty images is one row; `imageCount` / `workloadCount`
 * carry how widespread it is.
 */
type ClusterPackage = {
    name: string;
    version: string | null;
    purl: string | null;
    /** Syft's package type (`npm`, `go-module`, …); null for other tooling. */
    packageType: string | null;
    packageLanguage: string | null;
    license: string | null;
    imageCount: number;
    /** 0 when the package's images are scanned but not (yet) in any inventory. */
    workloadCount: number;
    /** Distinct running containers on an image carrying this version — the count the table shows. */
    containerCount: number;
    /** Clusters with at least one image carrying this version — always 1 on a cluster tab. */
    clusterCount: number;
    /** Distinct vulnerabilities on this package version, by severity. */
    vulnCounts: { critical: number; high: number; medium: number; low: number };
    /** Of those, the distinct ones on the CISA KEV catalogue — whatever their severity. */
    kevCount: number;
};

/**
 * Response of `GET /api/clusters/:id/components` and of the org-wide
 * `GET /api/components` — the same page, scoped to one cluster or to every
 * cluster of the organization.
 */
export type ClusterPackagesResponse = {
    packages: ClusterPackage[];
    total: number;
    limit: number;
    offset: number;
};

/**
 * One vulnerability in a cluster, collapsed to its advisory identity. The
 * same CVE on thirty images is one row; the package/image/workload counts
 * carry how widespread it is.
 */
type ClusterVulnerability = {
    /** The collapse key — pass to the occurrences drill-down verbatim. */
    identity: string;
    /** Display id: the identity's CVE, or the lone advisory id it stands for. */
    vulnId: string;
    /**
     * The advisory records that actually matched, when they are not the
     * display id — `GO-2026-4918` behind `CVE-2026-33814`. Sorted; absent from
     * an older server.
     */
    matchedVia?: string[];
    /**
     * The record the row's severity was lent by, when every matched record
     * publishes none of its own; null otherwise, absent from an older server.
     */
    severitySource?: string | null;
    /** On CISA KEV, or EPSS ≥ 0.1 — the rows the list puts first, whatever their severity. */
    exploited: boolean;
    /** Every finding behind the row is outside the requested lens; listed because it is exploited. */
    shownDespiteTier?: boolean;
    severity: 'critical' | 'high' | 'medium' | 'low' | null;
    /** What the advisory is about, in its own words; null when no record states it, absent from an older server. */
    summary?: string | null;
    /** Worst finding's 0–100 score across the components carrying it. */
    riskScore: number | null;
    /**
     * The advisory's Radar Score: the rounded sum of its findings'
     * contributions — what fixing it everywhere takes off the total. Null when
     * nothing behind the row is scored; absent from an older server.
     */
    radarScore?: number | null;
    /** Worst CVSS base score behind the row; null when no record publishes one, absent from an older server. */
    cvssScore?: number | null;
    epssScore: number | null;
    /** Non-null when the advisory is on the CISA KEV catalogue. */
    kevListedAt: string | null;
    /** CISA's federal remediation deadline; null off-catalogue. */
    kevDueDate: string | null;
    /** CISA's `knownRansomwareCampaignUse`, verbatim: "Known" or "Unknown". */
    kevRansomware: string | null;
    /** When the advisory was first made public; null when no record states it, absent from an older server. */
    publishedAt?: string | null;
    /**
     * Distinct affected package versions carrying the advisory in this
     * cluster, each with the fix version the matcher recorded (null when the
     * advisory states none for that package).
     */
    /** `purlType` is the purl's scheme word (`npm`, `maven`, `deb`); null without a purl, absent from an older server. */
    packages: { name: string; version: string | null; fixedVersion: string | null; purlType?: string | null }[];
    /** Distinct affected `name@version`s — each one upgrade; absent from an older server. */
    packageCount?: number;
    /** True when at least one finding of this advisory records a fix version. */
    fixAvailable: boolean;
    /** Findings (advisory × package × image) — the unit the severity cards count. */
    findingCount: number;
    imageCount: number;
    /** 0 when the affected images are scanned but not (yet) in any inventory. */
    workloadCount: number;
    /** Distinct running containers on an affected image — the count the table shows. */
    containerCount: number;
    /** Clusters with at least one affected image — always 1 on a cluster tab. */
    clusterCount: number;
    /**
     * Where the row's findings sit, under the request's filters: every lens
     * bucket and every image control behind it. Sets — one advisory is often
     * in an application package of one image and the base of another. Absent
     * from an older server.
     */
    buckets?: ('application' | 'base' | 'unknown')[];
    controls?: ImageControl[];
};

/**
 * One advisory record behind a listed row — the mirror's metadata for it,
 * minus the raw document.
 */
type ClusterVulnerabilityAdvisory = {
    vulnId: string;
    summary: string | null;
    severity: 'critical' | 'high' | 'medium' | 'low' | null;
    cvssScore: number | null;
    /** The record `severity` / `cvssScore` were lent by; null when they are this record's own, absent from an older server. */
    severitySource?: string | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: string | null;
    /** CISA's federal remediation deadline — label it as CISA's. */
    kevDueDate: string | null;
    /** CISA's `knownRansomwareCampaignUse`, verbatim: "Known" or "Unknown". */
    kevRansomware: string | null;
    publishedAt: string | null;
    modifiedAt: string | null;
    source: string;
    sourceUrl: string | null;
    aliases: string[];
};

/**
 * Response of `GET /api/clusters/:id/vulnerabilities/detail` — every advisory
 * record one row's identity collapses in this cluster (worst CVSS first) plus
 * the per-package fix versions the matcher recorded. The expand-row fetch.
 */
export type ClusterVulnerabilityDetail = {
    advisories: ClusterVulnerabilityAdvisory[];
    fixes: { packageName: string; fixedVersion: string }[];
};

/**
 * Response of `GET /api/clusters/:id/vulnerabilities` and of the org-wide
 * `GET /api/vulnerabilities` — the same page, scoped to one cluster or to
 * every cluster of the organization.
 */
export type ClusterVulnerabilitiesResponse = {
    vulnerabilities: ClusterVulnerability[];
    /** Distinct advisories matching the filter — what pagination pages over. */
    total: number;
    /** Findings matching the filter — the number the Overview severity cards report. */
    totalFindings: number;
    /** Findings whose source published no severity, under the search alone — the "Unscored" chip's count. */
    unscoredFindings: number;
    /** Findings per lens bucket under the search and severity filter, unlensed — the lens control's counts. */
    tierCounts?: TierCounts;
    /** Critical findings per lens bucket, under the search alone — what a lensed top-of-list leaves out. Absent from an older server. */
    criticalTierCounts?: TierCounts;
    /** The same for each band, under the search alone — the Dashboard's severity cards under its lens. Absent from an older server. */
    severityTierCounts?: Record<'critical' | 'high' | 'medium' | 'low', TierCounts>;
    limit: number;
    offset: number;
};

/**
 * Response of `GET /api/clusters/:id/components/occurrences` — every image
 * and workload one package version occurs in, the drill-down behind the
 * Packages tab's count cells. `GET /api/clusters/:id/vulnerabilities/occurrences`
 * answers in the same shape, so both popovers share it.
 */
export type ClusterPackageOccurrences = {
    images: {
        id: string;
        registry: string | null;
        repository: string | null;
        digest: string;
    }[];
    workloads: {
        /** A container of the workload running the package — the link target. */
        containerId: string;
        workloadName: string;
        workloadKind: string | null;
        namespaceName: string;
    }[];
};

/**
 * Response of the occurrence endpoints — `/components/occurrences` and
 * `/vulnerabilities/occurrences`, under `/api/clusters/:id` or org-wide:
 * the base shape plus the cluster each image or workload lives in, which
 * the org-wide lists need to say where a hit is and to link a workload into
 * its cluster.
 */
export type PackageOccurrences = {
    images: (ClusterPackageOccurrences['images'][number] & { clusterId: string; clusterName: string })[];
    workloads: (ClusterPackageOccurrences['workloads'][number] & { clusterId: string; clusterName: string })[];
};

export type VulnerabilityOccurrences = Omit<PackageOccurrences, 'images'> & {
    images: (PackageOccurrences['images'][number] & {
        /** Running containers on the image; 0 when it is scanned but in no inventory yet. Absent from an older server. */
        containerCount?: number;
        /**
         * The package versions carrying the advisory in this image, with where
         * in its filesystem each was found and whether it came with the base
         * image. Absent from an older server; `location` / `bucket` from an
         * older one still.
         */
        packages?: {
            name: string;
            version: string | null;
            /** The purl's scheme word — the ecosystem (`golang`, `npm`, `deb`). */
            purlType?: string | null;
            location?: string | null;
            bucket?: 'application' | 'base' | 'unknown';
        }[];
        /** When the image was built (its newest layer). Null = unknown. Absent from an older server. */
        builtAt?: string | null;
    })[];
    /**
     * Every running container on an affected image — what the list row's
     * Containers count counts; `workloads` folds a workload's containers into
     * one. Absent from an older server.
     */
    containers?: {
        containerId: string;
        containerName: string;
        init: boolean;
        workloadName: string;
        workloadKind: string | null;
        namespaceName: string;
        clusterId: string;
        clusterName: string;
        imageId: string;
        /** The reference the container runs, as deployed. */
        imageRef: string;
        /** The tag it was deployed by; null when by digest alone. Absent from an older server. */
        imageTag?: string | null;
        /** The Helm release that packaged the workload; null when Helm did not. Absent from an older server. */
        release?: { id: string; name: string; chartName: string | null; chartVersion: string | null } | null;
        /** Pods observed running this container on this digest; null when not reported. Absent from an older server. */
        runningPods?: number | null;
        /** The workload's earliest pod start, ISO — its age. Null when unknown. Absent from an older server. */
        firstStartedAt?: string | null;
    }[];
};

/**
 * Response of `GET /api/vulnerabilities/:vulnId/overview` — the vulnerability
 * page: the org list's row for the advisory, every record behind it, and
 * each image and workload it affects. 404 when nothing in the org carries it.
 */
export type VulnerabilityOverview = {
    vulnerability: ClusterVulnerability;
    detail: ClusterVulnerabilityDetail;
    occurrences: Omit<VulnerabilityOccurrences, 'workloads'> & {
        workloads: (VulnerabilityOccurrences['workloads'][number] & Partial<WorkloadExposure>)[];
    };
    /** Absent from an older server. */
    exposure?: VulnerabilityExposure;
    /** The advisory reaches more containers than exposure is computed for; the rest read "—". */
    exposureTruncated?: boolean;
    /** Absent from an older server. */
    remediation?: VulnerabilityRemediation;
};

/**
 * Time-to-remediate: containers that ran the advisory and whose next image
 * is scanned and clean of it. A container that simply went away was removed,
 * not fixed, and is not counted. Computed at read time, inside the plan's
 * history window.
 */
export type VulnerabilityRemediation = {
    containers: number;
    /** Whole days from `max(present, disclosed)` to the clean image; null when `containers` is 0. */
    medianDays: number | null;
    /** "At least": some container was already running it when StackRadar first looked. */
    medianIsLowerBound: boolean;
    truncated: boolean;
};

/** `LowerBoundReason` in the server's `lib/exposure.ts`. */
export type ExposureLowerBoundReason = 'first-observation' | 'history-unavailable' | 'unscanned';

/**
 * How long a finding has been on a container, folded across the workload's
 * containers that carry it (earliest wins, each flag follows its winner).
 * ISO strings. A `…IsLowerBound` date is "this long, or longer"; null is
 * "could not be computed", never zero.
 */
export type WorkloadExposure = {
    /** Start of the unbroken run of digests carrying it — a rollout between two affected digests does not reset it. */
    presentSince: string | null;
    presentSinceIsLowerBound: boolean;
    lowerBoundReason: ExposureLowerBoundReason | null;
    /** `max(presentSince, publishedAt)` — exposed while public. Null when the advisory has no publication date. */
    exposedSince: string | null;
    exposedSinceIsLowerBound: boolean;
    /** `max(presentSince, kevListedAt)`; null off KEV. */
    exploitedSince: string | null;
    exploitedSinceIsLowerBound: boolean;
};

export type VulnerabilityExposure = {
    publishedAt: string | null;
    kevListedAt: string | null;
    /** When the matcher first recorded it here. Display-only: a re-upload resets it. */
    detectedAt: string | null;
    longestPresentSince: string | null;
    longestPresentSinceIsLowerBound: boolean;
    longestPresentLowerBoundReason: ExposureLowerBoundReason | null;
    longestExposedSince: string | null;
    longestExposedSinceIsLowerBound: boolean;
    longestExploitedSince: string | null;
    longestExploitedSinceIsLowerBound: boolean;
};

/**
 * One image's share of a cluster's Radar Score — a row of the Radar Score
 * tab. Images partition the total (a finding belongs to one image, an image
 * to one cluster), so the rows' `score`s add up to the Overview chart's
 * number; workloads would double-count shared images, so they ride along as
 * context instead of being the unit.
 */
export type ClusterRadarScoreImage = {
    imageId: string;
    /** The cluster the image belongs to (ADR 0006) — the org page's Cluster column. */
    clusterId: string;
    clusterName: string;
    registry: string | null;
    repository: string | null;
    digest: string;
    /** Distinct tags deployments asked for, sorted; empty when digest-pinned everywhere. */
    tags: string[];
    /** Sum of the image's finding contributions — its share of the cluster total. */
    score: number;
    /** Band of the image's worst finding, never a threshold on the sum. */
    band: RiskBand;
    findingCount: number;
    kevCount: number;
    topFinding: { vulnId: string; risk: number } | null;
    /** Workloads running this image; empty when scanned but not in any inventory yet. */
    workloads: {
        containerId: string;
        namespaceName: string;
        workloadName: string;
        workloadKind: string | null;
    }[];
};

/** Response of `GET /api/clusters/:id/radar-score`. */
export type ClusterRadarScoreResponse = {
    images: ClusterRadarScoreImage[];
    /** The scope's Radar Score — every image's `score`, folded once. Never narrowed by `?control=`. */
    total: number;
    /**
     * The same sum, partitioned by who controls the image; `yours + upstream`
     * is `total`. Unconfirmed images count as yours, and `unconfirmedImages`
     * says how many there are.
     */
    byControl?: { yours: number; upstream: number; unconfirmedImages: number };
    /** Images with at least one finding — what pagination pages over. */
    imageCount: number;
    findingCount: number;
    limit: number;
    offset: number;
};

/**
 * One finding's contribution to an image's share — a row of the Radar Score
 * tab's expanded image. Response of `GET /api/clusters/:id/radar-score/findings`
 * is `{ findings: ClusterRadarScoreFinding[] }`, largest contribution first.
 */
export type ClusterRadarScoreFinding = {
    vulnId: string;
    summary: string | null;
    packageName: string;
    packageVersion: string | null;
    severity: 'critical' | 'high' | 'medium' | 'low' | null;
    /** The contribution, 0–100. */
    riskScore: number | null;
    cvssScore: number | null;
    epssScore: number | null;
    epssPercentile: number | null;
    kevListedAt: string | null;
    kevDueDate: string | null;
    kevRansomware: string | null;
    fixedVersion: string | null;
};
