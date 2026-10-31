/**
 * Shapes of the Fixes page — `GET /api/remediation/fixes`. Mirrors
 * `FixesPage` in `server/src/services/remediation.service.ts`.
 *
 * A lens over the suggestion feed: every move the product can recommend,
 * ranked measured-first, and every image with findings it has no move for,
 * each with the scan's stated reason. Read-only by construction — nothing on
 * this page applies anything, and nothing implies a move is safe.
 */

export type VersionBump = 'major' | 'minor' | 'patch' | 'none';

/**
 * Why an image with findings has no recommended move. The four scan verdicts
 * (`lib/image-tags.ts` refuses, never guesses) plus `eol`: every finding is
 * stranded on a release line that ships no more fixes, so the action is a
 * base-image migration rather than a tag bump.
 */
export type NoRecommendationReason = 'up-to-date' | 'no-candidates' | 'not-measured' | 'ambiguous-ordering' | 'eol';

export interface FixListItem {
    id: string;
    /** `base`: rebuild an image you build on a newer base — `subject` is the image, `from` / `to` are the base's refs. */
    kind: 'image' | 'chart' | 'base';
    /** Load-bearing: an unmeasured row may only say a newer chart *exists*. */
    measured: boolean;
    /**
     * What a measured row's numbers rest on: `sboms` — two SBOMs held here,
     * diffed; `chart-index` — the public chart index rendered and scored both
     * chart versions on their default values. Null when unmeasured.
     */
    evidence?: 'sboms' | 'chart-index' | null;
    /** What is being moved — `registry/repo` or the chart name. */
    subject: string;
    /** The release running the chart; null on the image axis. */
    release: { name: string; namespace: string } | null;
    from: string | null;
    to: string;
    bump: VersionBump;
    cluster: { id: string; name: string | null };
    /**
     * Which kind of action this is: `application` when most of what it clears
     * is in packages the build added, `base` when most is in the base image.
     * Absent from a server older than the component tier plan.
     */
    scope?: 'application' | 'base';
    /**
     * Who can make the move: `built` — an image the organization builds, so
     * the move is in its control; `third-party` — an upstream upgrade. Absent
     * from a server older than the component tier plan.
     */
    control?: 'built' | 'third-party';
    /**
     * What the move clears — null when unmeasured. `high` counts high *or*
     * critical; `byScope` splits `findings` into application packages and the
     * base image.
     */
    cleared: {
        findings: number;
        kev: number;
        high: number;
        introduced: number;
        byScope?: { application: number; base: number };
    } | null;
    /** Risk Score contribution the move removes — the rank key; null when unmeasured. */
    riskRemoved: number | null;
    /** An unmeasured chart bump's "could address up to" bound. */
    upperBound: { risk: number; findings: number } | null;
    /** Distinct workloads the move lands on (summed over a chart's images). */
    workloads: number;
    /** Running containers the move lands on — the number the UI prints. */
    containers: number;
    images: number;
    /** How the change is delivered, in one phrase, when it can be said. */
    delivery: string | null;
    /** Where the full panel and the delivery commands live. */
    target: { type: 'image'; imageId: string } | { type: 'release'; releaseId: string };
}

export interface NoRecommendationItem {
    imageId: string;
    /** `third-party` rows are the folded "Waiting on upstream" group. */
    control?: 'built' | 'third-party';
    subject: string;
    currentTag: string | null;
    cluster: { id: string; name: string | null };
    findings: number;
    kev: number;
    risk: number | null;
    reason: NoRecommendationReason;
    eolLines: { releaseLine: string; eolDate: string; findings: number }[];
}

export interface FixesResponse {
    totals: {
        /** Measured moves — the ones that can say what they clear. */
        upgrades: number;
        findingsCleared: number;
        kevCleared: number;
    };
    fixes: FixListItem[];
    noRecommendation: NoRecommendationItem[];
    /** Third-party images with findings and no upgrade to recommend. */
    waitingOnUpstream?: { images: number; findings: number };
}
