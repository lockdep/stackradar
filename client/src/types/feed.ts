import type { TierCounts } from '@/lib/tier-lens';
import type { ImageControl } from '@/lib/image-control';

/**
 * Shapes of the activity log as the Feed page reads it — `GET /api/feed`.
 * Mirrors the server's `activity_events` payloads: one event per change,
 * never one per finding; day grouping and folding happen in the view.
 */

import type { DeltaSummary } from '@/components/ui';
import type { ExposureLowerBoundReason } from './cluster';

export type IssueEventType =
    | 'issue.created'
    | 'issue.snoozed'
    | 'issue.applied'
    | 'issue.reopened'
    | 'issue.verified'
    | 'issue.closed'
    | 'issue.fix-available';

export type FindingEventType = 'finding.suppressed' | 'finding.unsuppressed';

// The activity feed's own types.
export type ContainerEventType =
    | 'container.appeared'
    | 'container.removed'
    | 'container.image-changed'
    | 'container.rollout-started'
    | 'container.retagged';

export type ActivityEventType =
    IssueEventType | FindingEventType | 'scan.criticals-increased' | ContainerEventType | 'scan.findings-changed';

interface ActivityEventBase {
    id: string;
    clusterId: string | null;
    imageId: string | null;
    issueId: string | null;
    createdAt: string;
}

/** Payload of `scan.criticals-increased`, the alarm that predates the feed. */
export interface CriticalsIncreasedPayload {
    repository?: string | null;
    criticalsBefore: number;
    criticalsAfter: number;
}

/**
 * Payload of the issue and finding events: the subject, named by `scope`.
 * Several server paths write these and each fills in only the fields its
 * scope has, so everything is optional and the reader picks by scope.
 */
export interface IssueEventPayload {
    scope?: 'image' | 'release' | 'finding';
    repository?: string | null;
    fromTag?: string | null;
    toTag?: string | null;
    chartName?: string | null;
    fromChartVersion?: string | null;
    toChartVersion?: string | null;
    vulnId?: string | null;
    packageName?: string | null;
    /** `finding.suppressed` only: why. */
    reason?: string | null;
}

/**
 * One row of the activity log, discriminated on `type` so that narrowing
 * the type narrows the payload — the feed's readers switch on `type` and
 * never cast a payload.
 */
export type ActivityEvent =
    | (ActivityEventBase & { type: ContainerEventType; payload: ContainerEventPayload })
    | (ActivityEventBase & { type: 'scan.findings-changed'; payload: FindingsChangedPayload })
    | (ActivityEventBase & { type: 'scan.criticals-increased'; payload: CriticalsIncreasedPayload })
    | (ActivityEventBase & { type: IssueEventType | FindingEventType; payload: IssueEventPayload });

/** The five `container.*` events share a payload; this narrows to them. Generic so it also narrows a `FeedEvent`. */
export function isContainerEvent<E extends ActivityEvent>(event: E): event is Extract<E, { type: ContainerEventType }> {
    return event.type.startsWith('container.');
}

/* ---------------------------------------------------------------------------
 * The Feed page — GET /api/feed.
 * ------------------------------------------------------------------------- */

/** One side of a container move, as the inventory diff recorded it. */
export interface ContainerSide {
    imageId: string;
    digest: string;
    tag: string | null;
    ref: string;
}

/** Payload of every `container.*` event. `from`/`to` are null on the side that has nothing. */
export interface ContainerEventPayload {
    namespace: string;
    workloadKind: string | null;
    workloadName: string;
    containerName: string;
    init: boolean;
    repository: string | null;
    from: ContainerSide | null;
    to: ContainerSide | null;
    /** The digest was not running anywhere in the cluster before. */
    imageNew?: boolean;
    /** The digest no longer runs anywhere in the cluster. */
    imageGone?: boolean;
    /** Equal, non-null tags on both sides of a move: `latest` re-pulled. */
    mutableTag?: boolean;
    /** `image-changed` only: what the move bought, when both digests were scanned. */
    delta?: DeltaSummary | null;
    deltaUnavailable?: 'from-unscanned' | 'to-unscanned' | null;
}

export interface ChangedFinding {
    key: string;
    vulnId: string;
    packageName: string;
    packageType: string;
    packageVersion: string | null;
    severityLevel: string | null;
    riskScore: number;
    kevListed: boolean;
    fixedVersion: string | null;
}

export interface RescoredFinding extends ChangedFinding {
    previousSeverityLevel: string | null;
}

/** Findings counted per severity band; `unscored` is everything outside the four. */
export interface SeverityBreakdown {
    critical: number;
    high: number;
    medium: number;
    low: number;
    unscored: number;
}

/** A workload container running an image, as a scan event names it. */
export interface FeedSlot {
    namespace: string;
    workloadKind: string | null;
    workloadName: string;
    containerName: string;
    init: boolean;
}

/** Payload of `scan.findings-changed`: one event per (image, scan), never one per finding. */
export interface FindingsChangedPayload {
    /**
     * `mirror`: the advisory database changed; nothing was deployed.
     * `upload`: the SBOM for the same digest was replaced and rescanned.
     * `first-scan`: the image had never been scanned — its findings are
     * inventory, not change, and the move that brought it carries the delta.
     */
    cause: 'mirror' | 'upload' | 'first-scan';
    replaced: boolean;
    repository: string | null;
    digest: string | null;
    /** The slots running the image when it was scanned. Absent on events written before it existed. */
    containers?: FeedSlot[];
    containerCount?: number;
    addedCount: number;
    removedCount: number;
    unchangedCount: number;
    /** Exact per-band counts. Absent on events written before the breakdown existed. */
    addedBySeverity?: SeverityBreakdown;
    removedBySeverity?: SeverityBreakdown;
    /**
     * Findings present before and after whose severity band moved — an
     * advisory re-scored under an image already running. Counted by the band
     * entered and the band left. Absent on events written before it existed.
     */
    rescoredCount?: number;
    rescored?: RescoredFinding[];
    rescoredToBySeverity?: SeverityBreakdown;
    rescoredFromBySeverity?: SeverityBreakdown;
    /** The head of each list, worst first; the counts are exact. */
    added: ChangedFinding[];
    removed: ChangedFinding[];
    riskBefore: number;
    riskAfter: number;
}

export type FeedEvent = ActivityEvent & {
    orgId: string;
    clusterName: string | null;
};

export interface FeedPage {
    events: FeedEvent[];
    nextCursor: string | null;
    /** The window actually served, after the plan clamp. */
    days: number;
    historyDays: number;
}

/* ---------------------------------------------------------------------------
 * "New vulnerabilities on running images" — GET /api/feed/movement. Mirrors `MovementImage`
 * in server/src/lib/recent-movement.ts plus the naming the controller joins.
 * ------------------------------------------------------------------------- */

export interface MovementContainer {
    containerId: string;
    /** The container's own name; shown only when it differs from its workload's. */
    name: string;
    namespace: string;
    /** Null is "could not look", never "none". */
    workloadKind: string | null;
    workloadName: string;
    /** The Helm release that packaged the workload; all null when none claims it. */
    releaseId: string | null;
    releaseName: string | null;
    chartName: string | null;
    chartVersion: string | null;
    /** Since when this container has run this digest. Null = not recorded yet. Absent from an older server. */
    onImageSince?: string | null;
    /** Already running when StackRadar first saw the cluster: "this long, or longer". */
    onImageSinceIsLowerBound?: boolean;
}

export interface MovementImage {
    imageId: string;
    clusterId: string | null;
    clusterName: string | null;
    /** The registry host; with `repository` it is the full path. Null when the image is gone or the host unknown. */
    registry: string | null;
    repository: string | null;
    digest: string | null;
    /** Who controls the image; null when it is gone, absent from an older server. */
    control?: ImageControl | null;
    /** The containers running the image now, by namespace then name — the live inventory, not the events. */
    runsIn: MovementContainer[];
    /** A real tag the image runs under, when one is known; the digest labels it otherwise. */
    tag: string | null;
    /** Findings that arrived in the window, by band. */
    added: SeverityBreakdown;
    /** Scored arrivals — the four bands, not `unscored`; rows exist and sort by these alone. */
    addedCount: number;
    /** Arrivals on CISA KEV. Ids are known for scan events only. */
    kev: number;
    kevVulnIds: string[];
    resolvedCount: number;
    /** Distinct container slots (namespace/workload/container) the events named as running the image. */
    containers: number;
    scans: number;
    moves: number;
    firstAt: string;
    lastAt: string;
}

export interface MovementResponse {
    since: string;
    until: string;
    /** The window actually served, after the plan clamp. */
    days: number;
    historyDays: number;
    /** Newest first by last arrival. Capped by the server; `totalImages` is the count before the cap. */
    images: MovementImage[];
    totalImages: number;
    /** The same count before the severity filter — what an empty filtered view can offer instead. */
    totalImagesAnySeverity?: number;
    /** Every scored finding that left in the window, across every image and move. */
    resolved: { count: number; bySeverity: SeverityBreakdown };
    /** Scored arrivals under each lens, whatever lens was asked for — the lens control's counts. */
    tierCounts?: TierCounts;
}

/**
 * One movement row unfolded — GET /api/feed/movement/:imageId/findings.
 * Mirrors `ArrivedFinding` in server/src/lib/recent-movement.ts.
 */
export interface MovementFinding extends ChangedFinding {
    /** `scan`: the advisory database changed under the image. `move`: a new tag brought it. */
    via: 'scan' | 'move';
    /** Outside the requested lens, listed because it is on KEV or EPSS ≥ 0.1. */
    shownDespiteTier?: boolean;
    /**
     * `via: 'scan'` only: since when the package carrying it has been running
     * on the containers of this image, across the digests that carried it —
     * the finding was already there when the advisory database caught up.
     * Null for a move, when unmeasured, and from an older server.
     */
    presentSince?: string | null;
    /** True: "this long, or longer" — never render it as an exact figure. */
    presentSinceIsLowerBound?: boolean;
    lowerBoundReason?: ExposureLowerBoundReason | null;
    publishedAt?: string | null;
}

export interface MovementFindingsResponse {
    imageId: string;
    since: string;
    until: string;
    days: number;
    historyDays: number;
    /** Worst first. Capped by the server; `total` is the count before the cap. */
    findings: MovementFinding[];
    total: number;
    /**
     * The list is not the whole count: a scan added more findings than its
     * event carried, or a move's previous digest is gone and could not be
     * diffed. The image page has everything.
     */
    partial: boolean;
    unmeasuredMoves: number;
}
