import type { MirrorStatus } from '@/lib/mirror-status';

interface VulnerabilityStats {
    /** Advisories the matcher can work with. Withdrawn ones are excluded here… */
    total: number;
    /** …and reported on their own, so the mirror size stays legible. */
    withdrawn: number;
    /** Also excludes withdrawn, so the bars sum to `total`. */
    bySeverity: Record<string, number>;
    /**
     * Active advisories with no CVSS score. Not the same as the `unknown`
     * severity bucket — that one means no level could be derived, this one
     * means there was no score to derive it from.
     */
    withoutCvssScore: number;
    affectedPackagesTotal: number;
}

/**
 * Whether the worker is healthy now, as opposed to `byStatus`, which counts
 * every job ever created and is therefore dominated by `completed`.
 */
export interface QueueHealth {
    /** Seconds the oldest pending job has waited. Null when nothing is pending. */
    oldestPendingAgeSeconds: number | null;
    /** Terminal outcomes in the last 24h, keyed on completion. Cancellations excluded. */
    last24h: { completed: number; failed: number };
    /** Failed jobs with no retries left — nothing moves these without a person. */
    stuckAtMaxRetries: number;
}

interface SystemStats {
    organizations: { total: number; byPlan: Record<string, number> };
    users: { total: number };
    jobs: {
        total: number;
        byStatus: Record<string, number>;
        byType: Record<string, number>;
        health: QueueHealth;
    };
    vulnerabilities: VulnerabilityStats;
    sboms: { total: number };
    components: { total: number; withVulnerabilities: number };
    /**
     * The `images` table platform-wide. `total - withSbom` is the ingest
     * backlog; `orphaned` is what the nightly GC is aiming at.
     */
    images: {
        total: number;
        withSbom: number;
        /** Referenced by nothing — GC candidates once they age out. */
        orphaned: number;
        /**
         * Running somewhere with no SBOM — the ingest backlog. Not
         * `total - withSbom`, which also swallows the orphans nobody runs.
         */
        awaitingSbom: number;
    };
    /** The Kubernetes inventory, counted once across every tenant. */
    kubernetes: {
        clusters: number;
        namespaces: number;
        workloads: number;
        /** `workload_containers` rows — one digest in forty places is forty of these. */
        containers: number;
        helmReleases: number;
    };
}

export interface OsvSyncState {
    initialized: boolean;
    syncStatus: string;
    lastSuccessfulPollAt: string | null;
    /** What OSV has published. Paired with lastModifiedApplied this gives real lag. */
    lastModifiedSeen: string | null;
    lastModifiedApplied: string | null;
    lastFullRefreshAt: string | null;
    affectedPkgGeneration: number;
    consecutiveFailures: number;
    lastError: string | null;
    updatedAt: string;
    /** OSV directories the live generation carries; null = the whole corpus (`OSV_ECOSYSTEMS`). */
    ecosystems: string[] | null;
}

export interface OsvGeneration {
    generation: number;
    rowCount: number;
    isCurrent: boolean;
}

export interface OsvSyncRun {
    id: string;
    mode: string;
    success: boolean;
    recordsProcessed: number;
    inserted: number;
    updated: number;
    unchanged: number;
    parseFailures: number;
    durationMs: number;
    lagSeconds: number | null;
    startedAt: string;
    completedAt: string;
}

/** Records the mirror could not take. Above zero means the mirror has a hole. */
export interface OsvParseFailures {
    total: number;
    last7Days: number;
    byType: Record<string, number>;
}

/**
 * Records that deviated from the OSV JSON schema and were ingested anyway.
 * Mostly upstream publishers violating the spec, so a steady non-zero count is
 * normal — it is a data-quality signal, not a data-loss one.
 */
export interface OsvValidationWarnings {
    total: number;
    last7Days: number;
}

interface ParseFailureRow {
    id: number;
    syncRunId: string;
    syncMode: string;
    osvId: string | null;
    ecosystemDir: string | null;
    sourcePath: string;
    errorType: string;
    occurredAt: string;
}

export interface ParseFailuresPage {
    failures: ParseFailureRow[];
    total: number;
    limit: number;
    offset: number;
}

export interface OsvStatus {
    state: OsvSyncState | null;
    /** The server's `OSV_ECOSYSTEMS`; null = everything. Differs from `state.ecosystems` until the next bootstrap. */
    configuredEcosystems: string[] | null;
    generations: OsvGeneration[];
    recentRuns: OsvSyncRun[];
    parseFailures: OsvParseFailures;
    validationWarnings: OsvValidationWarnings;
}

// ── Feed syncs (EPSS / KEV / Artifact Hub) ───────────────────────────────────

/**
 * One overwritten state row per feed — last run only, no history. A failed run
 * sets `lastError` without touching `lastSyncedAt`, so fresh data plus an error
 * means "last night failed, yesterday's data is still live"; render both.
 */
interface EpssFeedState {
    lastSyncedAt: string | null;
    /** The age the data claims (`score_date` from the CSV header), not when we fetched it. */
    lastScoreDate: string | null;
    rowsInFile: number | null;
    rowsMatched: number | null;
    /** Expected to be tens of thousands — a collapse in `rowsMatched` is the broken-join signal. */
    rowsUnmatched: number | null;
    lastError: string | null;
    updatedAt: string;
}

interface KevFeedState {
    lastSyncedAt: string | null;
    catalogVersion: string | null;
    releasedAt: string | null;
    entriesInCatalog: number | null;
    entriesMatched: number | null;
    /** Advisories whose KEV columns the run cleared because CISA withdrew the CVE. */
    entriesCleared: number | null;
    lastError: string | null;
    updatedAt: string;
}

interface ArtifactHubFeedState {
    lastSyncedAt: string | null;
    packagesInDump: number | null;
    packagesApplied: number | null;
    /** Attribution counters are a separate write after the mirror pass — null until it runs. */
    chartsExamined: number | null;
    attributionsWritten: number | null;
    attributionsRefused: number | null;
    reposAutoAdded: number | null;
    lastError: string | null;
    updatedAt: string;
}

export interface FeedsData {
    /** The threshold the `stale` flags were computed with, server-side. */
    staleAfterHours: number;
    epss: {
        state: EpssFeedState | null;
        stale: boolean;
        /** Advisories currently carrying a score — the live decoration, not the last run's count. */
        advisoriesWithScore: number;
    };
    kev: {
        state: KevFeedState | null;
        stale: boolean;
        advisoriesListed: number;
    };
    artifactHub: {
        state: ArtifactHubFeedState | null;
        stale: boolean;
        /** Live row counts — what the stamp-and-prune mirror holds now. */
        mirrorPackages: number;
        attributions: number;
    };
}

/**
 * The caps an org's usage is drawn against, resolved by the server from the
 * same `getPlanLimits` every limit check uses. `null` is "no cap" — JSON
 * cannot carry `Infinity`, and a client-side mirror of the plan table is what
 * this replaced: it did not know the community plan, so a three-member
 * install read "3 / 1 members".
 */
export interface AdminOrgLimits {
    members: number | null;
    clusters: number | null;
    sboms: number | null;
}

export interface RecentOrg {
    id: string;
    name: string;
    slug: string;
    plan: string;
    /** The Stripe subscription's status; `trialing` is badged. Absent from older servers. */
    stripeSubscriptionStatus?: string | null;
    /** The live demo's org: read-only, its plan is not a sale. */
    demo?: boolean;
    createdAt: string;
    memberCount: number;
    sbomCount: number;
    clusterCount: number;
    limits: AdminOrgLimits;
}

export interface EcosystemEntry {
    ecosystem: string;
    count: number;
}

/** One cluster's scanner facts; the verdicts are the client's (`getScannerHealth`, `isScannerOutdated`). */
export interface AdminScannerRow {
    id: string;
    name: string;
    orgId: string;
    scannerVersion: string | null;
    scannerLastSeenAt: string | null;
    kubernetesVersion: string | null;
    /** `false` is a permissions failure the agent reported; `null` is an agent too old to say. */
    ownerMetadataCollected: boolean | null;
}

/** The pipeline's first three stages as the freshest fact each has written. Null is "not yet", never "broken". */
export interface PipelineHealth {
    scanner: {
        minVersion: string | null;
        clusters: AdminScannerRow[];
        total: number;
    };
    inventory: { newestSeenAt: string | null };
    sboms: { newestCreatedAt: string | null };
}

export interface OverviewData {
    stats: SystemStats;
    osvState: OsvSyncState | null;
    pipeline: PipelineHealth;
    feeds: FeedsData;
    /** The fresh-install state the app shell's banner reads, for the "still building" case. */
    mirror: MirrorStatus;
}

export interface OrganizationsData {
    recentOrgs: RecentOrg[];
}

interface WithdrawnStats {
    /** Advisories in the mirror that OSV has since retracted. */
    advisories: number;
    /**
     * Findings still shown to customers for a retracted advisory. The matcher
     * refuses to create these, but nothing retracts one made before the
     * withdrawal — so a non-zero value is live wrong data, not history.
     */
    staleFindings: { links: number; components: number; advisories: number };
    /**
     * Affected-package rows whose denormalised `withdrawn` flag disagrees with
     * the advisory. Expected to be permanently zero; non-zero means the
     * matcher's partial index still holds candidates it was built to exclude.
     */
    denormalizationDrift: number;
}

export interface VulnerabilitiesData {
    vulnerabilities: VulnerabilityStats;
    ecosystemDistribution: EcosystemEntry[];
    advisoryIdDistribution: EcosystemEntry[];
    withdrawn: WithdrawnStats;
}

export type JobStatus = 'pending' | 'scheduled' | 'processing' | 'completed' | 'failed' | 'cancelled';
type JobType =
    'vulnerability_scan' | 'full_sync' | 'scheduled_scan' | 'chart_render' | 'platform_scan' | 'chart_repo_refresh';
export type JobTrigger = 'manual' | 'sbom_upload' | 'schedule' | 'system';

export interface AdminJob {
    id: string;
    orgId: string;
    orgName: string;
    orgSlug: string;
    imageId: string | null;
    type: JobType;
    status: JobStatus;
    priority: number;
    title: string;
    triggeredBy: JobTrigger;
    scheduledFor: string | null;
    startedAt: string | null;
    completedAt: string | null;
    progress: number;
    progressMessage: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    retryCount: number;
    maxRetries: number;
    createdAt: string;
}

export interface AdminJobsData {
    jobs: AdminJob[];
    total: number;
    limit: number;
    offset: number;
}

// ── Matcher quality ──────────────────────────────────────────────────────────

/** The key a match-metadata distribution uses for a null column — see UNRECORDED. */
export const UNRECORDED = 'unrecorded';

interface EcosystemDisagreement {
    /** Family part of `matched_ecosystem`: 'Alpine', 'Debian', 'npm'. */
    family: string;
    /** The PURL type that family publishes under. */
    expectedPurlType: string;
    /** The PURL type the component actually is. */
    componentPurlType: string;
    count: number;
}

export interface MatcherQualityData {
    total: number;
    byMatchType: Record<string, number>;
    byMatchConfidence: Record<string, number>;
    byMatchedBy: Record<string, number>;
    ecosystemAgreement: {
        agreeing: number;
        disagreeing: number;
        /** Provenance predates the `matched_ecosystem` column. */
        unrecorded: number;
        /** One side maps to no PURL type — the question cannot be asked of these. */
        unresolvable: number;
        topDisagreements: EcosystemDisagreement[];
    };
}

export type Tab =
    | 'overview'
    | 'system'
    | 'organizations'
    | 'users'
    | 'feedback'
    | 'images'
    | 'vulnerabilities'
    | 'matcher'
    | 'osv'
    | 'feeds'
    | 'jobs'
    | 'explorer'
    | 'chart-index';

// ── Images ───────────────────────────────────────────────────────────────────

/**
 * What to do about an image, as one word. Ordered by precedence, not by
 * exclusivity — an orphaned image may still carry an SBOM, and `orphaned` wins
 * because it is the fact with a deadline on it.
 */
export type AdminImageState = 'orphaned' | 'awaiting_sbom' | 'scanned';

export type AdminImageSort = 'lastSeen' | 'firstSeen' | 'repository';

/** One row of `images`, across every cluster. Admin-only: where a digest runs is provenance. */
export interface AdminImage {
    id: string;
    digest: string;
    registry: string | null;
    repository: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    sbomId: string | null;
    sbomFormat: string | null;
    sbomCreatedAt: string | null;
    componentCount: number;
    /** `null` = nobody has matched it yet. Never render as zero. */
    findings: SeverityCounts | null;
    containerCount: number;
    /** 1 under ADR 0006 for any row with containers — an image belongs to one cluster. */
    clusterCount: number;
    state: AdminImageState;
    /** Days until the GC cutoff reaches it, rounded up; <= 0 once past. Null unless orphaned. */
    gcInDays: number | null;
}

export interface AdminImagesData {
    images: AdminImage[];
    total: number;
    limit: number;
    offset: number;
    /** Unfiltered, so the filter control's own counts never move when it is used. */
    stateTotals: Record<AdminImageState, number>;
    /**
     * Days an unreferenced image is kept before the GC collects it. On the
     * cloud this is the floor every plan's window is at least; in the
     * community edition, where there is one plan, it is the window itself.
     */
    retentionDays: number;
}

// ── SBOM Explorer ────────────────────────────────────────────────────────────

export interface SeverityCounts {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unknown: number;
}

/**
 * The explorer's first level is images, not projects.
 *
 * The same base image used to appear once per workload that ran it; one row
 * per image is both shorter and the level a remediation acts on.
 */
export interface ExplorerImage {
    imageId: string;
    digest: string;
    registry: string | null;
    repository: string | null;
    sbomId: string;
    format: string;
    generatedAt: string | null;
    createdAt: string;
    /** How many running containers reference this image, across the org. */
    deploymentCount: number;
    componentCount: number;
    vulnCounts: SeverityCounts;
}

export interface ExplorerImagesData {
    images: ExplorerImage[];
}

export interface ExplorerSbom {
    id: string;
    format: string;
    specVersion: string;
    sourceName: string | null;
    digest: string;
    toolName: string | null;
    toolVersion: string | null;
    generatedAt: string | null;
    createdAt: string;
    componentCount: number;
    vulnCounts: SeverityCounts;
}

export interface ExplorerSbomsData {
    sboms: ExplorerSbom[];
}

export interface ExplorerComponent {
    id: string;
    name: string;
    version: string | null;
    type: string;
    purl: string | null;
    groupName: string | null;
    isDirect: boolean | null;
    scope: string | null;
    vulnCounts: SeverityCounts;
}

export interface ExplorerComponentsData {
    components: ExplorerComponent[];
    total: number;
    limit: number;
    offset: number;
}

interface ExplorerRangeEvent {
    introduced?: string;
    fixed?: string;
    last_affected?: string;
    limit?: string;
}

interface ExplorerRange {
    type: string;
    repo?: string;
    events: ExplorerRangeEvent[];
}

interface ExplorerReference {
    type: string;
    url: string;
}

interface ExplorerAffectedPackage {
    ecosystem: string | null;
    packageName: string;
    purl: string | null;
    versions: string[];
    ranges: ExplorerRange[];
    fixedVersion: string | null;
}

export interface ExplorerComponentVulnerability {
    id: string;
    vulnId: string;
    summary: string | null;
    details: string | null;
    severityLevel: string | null;
    cvssScore: number | null;
    aliases: string[];
    references: ExplorerReference[];
    publishedAt: string | null;
    modifiedAt: string | null;
    matchedBy: string | null;
    matchConfidence: string | null;
    // Recorded by the matcher at the moment it decided this match.
    // `affectedPackages` lists every entry of the advisory; these say which one
    // won, which is the question this view exists to answer.
    matchType: string | null;
    matchedEcosystem: string | null;
    matchedFixedVersion: string | null;
    upstreamName: string | null;
    upstreamVersion: string | null;
    affectedPackages: ExplorerAffectedPackage[];
}

export interface ExplorerComponentDetailData {
    component: {
        id: string;
        name: string;
        version: string | null;
        type: string;
        purl: string | null;
        cpe: string | null;
        groupName: string | null;
        isDirect: boolean | null;
        scope: string | null;
    };
    vulnerabilities: ExplorerComponentVulnerability[];
}
