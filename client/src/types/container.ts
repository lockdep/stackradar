import type { RiskRollup, RiskBand } from '@/lib/risk';
import type { TierCounts } from '@/lib/tier-lens';
import type { ControlSignal, ImageControl } from '@/lib/image-control';

/**
 * What the list is ranked by.
 *
 * `severity` is the one that makes this a triage surface rather than an
 * inventory: "show me the worst one" is the question a vulnerability product
 * exists to answer, and until it was here the user answered it by eye.
 *
 * `firstSeen` and `built` are the `/images` list's; a containers table has no
 * such column and orders by name for them.
 */
export type SortColumn = 'name' | 'scannedAt' | 'onImage' | 'severity' | 'risk' | 'firstSeen' | 'built';

export type SortDirection = 'asc' | 'desc';

/**
 * A predicate over the list, named so it can live in the URL. Only one is
 * left — the coverage strip's toggle — but the shape stays a union so the
 * URL, the predicate table and the strip agree on the name.
 *
 * `unscanned` means **no SBOM**, which is what the Scanned column and the
 * coverage strip both already mean by it. It is deliberately not
 * `vulnerabilities === null`: an image can have an SBOM and no vulnerability
 * scan yet, and calling that "not scanned" would contradict the strip it is
 * clicked from.
 */
export type ContainerFilter = 'unscanned';

export type VulnerabilityCounts = {
    critical: number;
    high: number;
    medium: number;
    low: number;
    /**
     * Findings whose advisory carries no severity at all. Not a fifth band —
     * the absence of one — so it is counted apart and hidden by default.
     * Optional because only the grouped workload endpoint reports it.
     */
    unscored?: number;
};

/**
 * One running container — the addressable unit of the containers API.
 *
 * Not a workload: findings belong to the *image* a container references, and a
 * workload with two containers on two images has two different answers to
 * "what is wrong with it". A Deployment mid-rollout produces two rows for one
 * container name, on two digests; that is the model working, not a duplicate.
 */
export type Container = {
    id: string;
    name: string;
    init: boolean;
    /** What the deployment asked for. `null` when digest-pinned — never 'latest'. */
    imageTag: string | null;
    imageRef: string;
    runningPods: number | null;
    firstSeenAt: string;
    lastSeenAt: string;

    workloadId: string;
    workloadName: string;
    /** `null` when the scanner could not resolve `ownerReferences`. Never guessed. */
    workloadKind: string | null;
    /**
     * Allowlisted pod labels merged over the controller's, the pod winning.
     *
     * The merge is why `app.kubernetes.io/part-of` is usually here even for a
     * workload whose pod template never carried it, which is what lets the
     * unattributed bucket sub-group by suite with no extra request.
     */
    workloadLabels: Record<string, string> | null;

    namespaceId: string;
    namespaceName: string;
    clusterId: string;

    releaseId: string | null;
    releaseName: string | null;
    chartName: string | null;
    chartVersion: string | null;

    /**
     * The delivery layer, independent of the release above. A workload commonly
     * has both — the chart version is what a CVE report cites, the app is where
     * an Argo user makes the fix — so neither is derivable from the other.
     */
    applicationId: string | null;
    applicationName: string | null;

    imageId: string;
    imageDigest: string;
    registry: string | null;
    repository: string | null;
    /**
     * Who controls the image, which signal decided it, and what that signal
     * saw (a chart name, a registry host). Absent from an older server.
     */
    control?: ImageControl;
    controlDetectedBy?: ControlSignal | null;
    controlDetail?: string | null;

    /** Null until an SBOM lands for the image. */
    sbomId: string | null;
    /** When the SBOM was generated. Fixed for the life of the digest. */
    scannedAt: string | null;
    /**
     * When the SBOM was last matched against the OSV mirror — how fresh the
     * findings are. Moves with every mirror-changing sync while `scannedAt`
     * stands still; null until a scan run completes.
     */
    lastMatchedAt: string | null;
    /**
     * Since when this container has run *this digest* — the start of its open
     * history interval. Not the stitched exposure across earlier digests,
     * which is the container page's. Null = not recorded yet, never zero.
     * Absent from an older server.
     */
    onImageSince?: string | null;
    /** Already running when StackRadar first saw the cluster: "this long, or longer". */
    onImageSinceIsLowerBound?: boolean;
    componentCount: number;
    /**
     * **`null` means nobody has scanned this image yet.** Zeroes mean we looked
     * and found nothing, which is a very different thing to tell someone about
     * their production workload — render the first as a dash.
     */
    vulnerabilities: VulnerabilityCounts | null;
    /**
     * Distinct packages on this image that a finding says how to fix — the unit
     * of work, not the unit of alarm. One `openssl` bump can close a dozen
     * findings, and "12 fixable" would describe an afternoon that does not
     * exist.
     *
     * `null` under the same condition as `vulnerabilities`: nobody has looked.
     * Zero means we looked and nothing states a fix.
     */
    fixableComponents: number | null;
    /**
     * The container's image's total risk — the unbounded sum of its findings'
     * scores (ADR 0007).
     *
     * The *image's* score, because the row is a container and a container runs
     * one image. Two containers of one workload on two images carry two
     * different numbers, and that difference is which to fix first.
     *
     * `null` under the same condition as the two fields above.
     */
    risk: RiskRollup | null;
};

/** A Helm release, with what it deploys. */
export type Release = {
    id: string;
    clusterId: string;
    /** The **release's** namespace, which may differ from its workloads'. */
    namespace: string;
    name: string;
    chartName: string | null;
    chartVersion: string | null;
    appVersion: string | null;
    /** `null` means unknown, not "no repo" — pod metadata cannot supply it. */
    repoUrl: string | null;
    workloadCount: number;
    containerCount: number;
    imageCount: number;
    namespaceCount: number;
    /**
     * Summed across every workload the chart deploys, including the ones that
     * landed in another namespace, deduplicated by image. See `db/risk.ts`.
     */
    risk: RiskRollup;
    /**
     * Another release claims the same chart name from a repository we cannot
     * prove is the same one. Several repos publish `nginx`, so the UI has to
     * say so rather than imply the releases are the same chart.
     */
    chartNameAmbiguous: boolean;
    /**
     * The Artifact Hub-attributed repository when `repoUrl` is null — an
     * evidence-backed inference, labelled as one. Only on the detail payload;
     * absent (undefined) on the list.
     */
    attributedRepoUrl?: string | null;
    /**
     * The chart reads as deprecated in its Artifact Hub package. `null` =
     * cannot say (no attribution). Only on the detail payload.
     */
    chartDeprecated?: boolean | null;
    /**
     * The Artifact Hub package this chart matched, when the match speaks for
     * this release — the nightly attribution pass found it, and the repository
     * it names is either the one the scanner observed or the one it stands in
     * for. `null` = no match, or a match for a different repository's chart of
     * the same name.
     *
     * Everything on it is **unmeasured**: `newerVersion` is a listing, not a
     * version anyone here runs, and nothing has scanned what it deploys.
     */
    artifactHub: ArtifactHubMatch | null;
};

/** See `server/src/lib/chart-attribution.ts`. */
type ArtifactHubMatch = {
    repoName: string;
    repoUrl: string;
    /** The package's page on Artifact Hub, so a user can check the claim. */
    url: string;
    /** The repo was inferred rather than observed — label it as an inference. */
    inferred: boolean;
    /** Newest non-deprecated listed version above the installed one. */
    newerVersion: string | null;
    latestVersion: string | null;
    deprecated: boolean;
};

export type ReleasesResponse = {
    releases: Release[];
    /** Workloads no chart manages. Shown, never hidden — see the releases API. */
    unmanaged: { workloads: number; containers: number };
};

/**
 * An image, with its findings and how widely it is deployed.
 *
 * Cluster-scoped (ADR 0006): the same digest deployed in two clusters is two
 * images, and `clusterName` is what tells the rows apart.
 */
export type Image = {
    id: string;
    digest: string;
    clusterId: string;
    clusterName: string | null;
    registry: string | null;
    repository: string | null;
    /** Who controls the image, which signal decided it, and what it saw. Absent from an older server. */
    control?: ImageControl;
    controlDetectedBy?: ControlSignal | null;
    controlDetail?: string | null;
    /**
     * Facts about the image itself, as the scanner sent them (0.4.0 and
     * later): `baseName`, `version`, `source`, `user`… Null until then.
     */
    metadata?: Record<string, string> | null;
    /**
     * Where the base image ends: its name when something could name it, how
     * many of the image's layers are its, and which signal decided
     * (`annotation`, `known-image`, `org-prefix`, `buildpacks`, `history`).
     * Either of the first two can be null alone.
     */
    baseImageRef?: string | null;
    baseLayerCount?: number | null;
    baseDetectedBy?: string | null;
    firstSeenAt: string;
    sbomId: string | null;
    /** When the SBOM was generated. Fixed for the life of the digest. */
    scannedAt: string | null;
    /**
     * When the SBOM was last matched against the OSV mirror — how fresh the
     * findings are. Null until a scan run completes.
     */
    lastMatchedAt: string | null;
    componentCount: number;
    vulnerabilities: VulnerabilityCounts | null;
    containerCount: number;
    tags: string[];
    /** Names of the namespaces it runs in. Only on the list payload; absent from an older server. */
    namespaces?: string[];
    /**
     * The image's total risk — the unbounded sum of its findings' scores.
     * `null` when nobody has scanned it.
     *
     * Needs no un-multiplying here and means the same thing whether the digest
     * runs in one namespace or twenty — a finding keys on the digest. How many
     * places it runs is `containerCount`.
     */
    risk: RiskRollup | null;
};

/** Where an image runs. One row per container referencing it. */
export type ImageDeployment = {
    containerId: string;
    containerName: string;
    init: boolean;
    imageTag: string | null;
    imageRef: string;
    runningPods: number | null;
    workloadId: string;
    workloadName: string;
    workloadKind: string | null;
    namespaceId: string;
    namespaceName: string;
    clusterId: string;
    releaseId: string | null;
    applicationId: string | null;
    /** Since when the container has run this digest. Null = not recorded yet. Absent from an older server. */
    onImageSince?: string | null;
    /** Already running when StackRadar first saw the cluster: "this long, or longer". */
    onImageSinceIsLowerBound?: boolean;
};

type OsvRangeEvent = {
    introduced?: string;
    fixed?: string;
    last_affected?: string;
    limit?: string;
};

export type OsvRange = {
    type: 'SEMVER' | 'ECOSYSTEM' | 'GIT';
    repo?: string;
    events: OsvRangeEvent[];
};

/**
 * View-optimized: vulnerability detail within a grouped response
 */
export type VulnerabilityDetail = {
    id: string;
    vulnId: string;
    source: string;
    sourceUrl?: string | null;
    summary?: string | null;
    severityLevel?: string | null;
    cvssScore?: number | null;
    /**
     * The ranking inputs, on every finding.
     *
     * Carried because a row that sorts above a CVSS 9.8 has to be able to say
     * why. `epssScore: null` means FIRST.org does not score this advisory and
     * must render as `EPSS —` — the model's stand-in for an unscored advisory
     * is our assumption, not their finding, and printing it as a score would
     * attribute it to them.
     */
    riskScore?: number | null;
    epssScore?: number | null;
    epssPercentile?: number | null;
    kevListedAt?: string | null;
    kevDueDate?: string | null;
    kevRansomware?: string | null;
    publishedAt?: string | null;
    fixedVersion?: string | null;
    /**
     * Set only when this finding was inherited from a source package — an apk
     * `libcrypto3` picking up an advisory published against `openssl`.
     *
     * When present it is the package `fixedVersion` refers to. Quoting the fix
     * beside `componentName` instead would attribute a version to a package the
     * advisory never mentions.
     */
    upstreamName?: string | null;
    affectedRanges?: OsvRange[] | null;
    affectedVersions?: string[] | null;
    componentName: string;
    /**
     * Other advisories describing this same vulnerability, folded into this
     * row by the server so one flaw is one finding rather than one per
     * publisher — a GHSA and the CVE it aliases are a single thing to fix.
     *
     * Shown rather than dropped: the collapsed ids are what explains why the
     * tab lists fewer findings than the raw advisory count.
     */
    aliasIds?: string[];
    /** Outside the requested lens, listed because it is on KEV or EPSS ≥ 0.1. */
    shownDespiteTier?: boolean;
};

/**
 * View-optimized: vulnerabilities grouped by component
 */
export type VulnerabilityGroup = {
    componentId: string;
    componentName: string;
    componentVersion: string | null;
    isDirect: boolean;
    dependencyPath: { name: string; version: string | null }[] | null;
    packageType: string | null;
    location: string | null;
    maxCvss: number | null;
    /**
     * The group's summed risk — "how much does bumping this package buy".
     *
     * The list is ordered by this rather than by `maxCvss`: a package carrying
     * six exploited mediums is more urgent than one carrying a single critical
     * nobody has ever attacked, and CVSS ordering cannot say so.
     */
    risk: number;
    /** The band of the group's worst finding, never of the summed total. */
    riskBand: RiskBand;
    /** Findings in this group on CISA's KEV catalogue. */
    kevCount: number;
    counts: VulnerabilityCounts;
    hasFixAvailable: boolean;
    /**
     * The version to upgrade this component to so every finding on it is fixed:
     * the highest fix version in the group, ordered by the server using the
     * component's own package-manager semantics (`server/src/matching/version/`).
     *
     * Null when no finding states a fix. Never re-derive it in the browser — a
     * distro version like `3.6.0-r0` cannot be ordered by splitting on dots.
     */
    fixVersion: string | null;
    /**
     * The one line that bumps the package to `fixVersion` in the reader's own
     * build (`npm install lodash@4.17.21`). Only for an application package in
     * an ecosystem where that line is unambiguous; null otherwise. Advice.
     */
    bumpCommand?: string | null;
    /** Whether the package came with the base image; null while the boundary is unknown. */
    fromBase?: boolean | null;
    /** The Dockerfile line that made the layer the package first exists in — redacted by the scanner, cut to 120 characters. */
    layerCreatedBy?: string | null;
    vulnerabilities: VulnerabilityDetail[];
};

/**
 * Response from GET /api/containers/:id/vulnerabilities/grouped
 */
export type VulnScanStatus = 'completed' | 'pending' | 'processing' | 'stale' | 'failed' | 'not_started';

export type GroupedVulnerabilitiesResponse = {
    /** Counts of what the lens shows; `tierCounts` has every bucket. */
    summary: VulnerabilityCounts & { total: number };
    hasDependencies: boolean;
    groups: VulnerabilityGroup[];
    /** Findings per lens bucket, unlensed — the "Application · Base image · All" control's counts. */
    tierCounts: TierCounts;
    currentSbom: {
        id: string;
        createdAt: string;
        format: string;
        specVersion: string;
        /* Deployment facts, read off the container rather than the SBOM. An
           SBOM describes bytes and carries no tag, ref or labels — that split
           is what lets a public image's SBOM be shared across tenants. Both
           null when the table is keyed on the image rather than a container:
           a digest may run under several tags, and picking one would be a
           guess. */
        imageTag: string | null;
        imageRef: string | null;
        toolName: string | null;
        toolVersion: string | null;
        sbomSha256: string;
        documentVersion: number | null;
        componentCount: number;
    } | null;
    vulnScan: {
        status: VulnScanStatus;
        completedAt: string | null;
        jobId: string | null;
    } | null;
};

/**
 * View-optimized: single dependency with children pre-resolved
 */
export type DependencyOverviewItem = {
    id: string;
    name: string;
    version: string | null;
    isDirect: boolean;
    license: string | null;
    purl: string | null;
    vulnerabilities: { id: string; severity: string | null }[];
    children: string[];
    dependencyPath: { name: string; version: string | null }[] | null;
    packageType: string | null;
    location: string | null;
};

/**
 * Response from GET /api/containers/:id/dependencies/overview
 */
export type DependenciesOverviewResponse = {
    summary: { total: number; direct: number; transitive: number };
    dependencies: DependencyOverviewItem[];
};

/**
 * Response of `GET /api/containers/:id/exposure` — how long each advisory has
 * been on this container's slot, across the digests that carried it, and the
 * container's one headline figure: the longest known-exploited finding, else
 * the longest-exposed critical or high one. A displayed fact; it is in no
 * score. `findings` is keyed by advisory id (the CVE, and each record id).
 */
export type ContainerExposure = {
    findings: Record<string, import('./cluster').WorkloadExposure>;
    longest: {
        kind: 'exploited' | 'exposed';
        vulnId: string;
        since: string;
        isLowerBound: boolean;
        lowerBoundReason: import('./cluster').ExposureLowerBoundReason | null;
    } | null;
};
