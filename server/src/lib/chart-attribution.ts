/**
 * Chart attribution: which Artifact Hub package is this installed chart?
 *
 * Pure — candidates in, decision out. The matcher is **refusal-first**:
 * identity evidence is required (the installed chart version must appear in
 * the candidate's version list; app-version agreement is a bonus tier), and
 * authority (verified > official > stars) only breaks ties among candidates
 * that already carry identity evidence. An unresolvable tie refuses.
 *
 * This deliberately fixes the failure modes in Fairwinds Nova's matcher that
 * the proposal reviews: zero-score accepts (a candidate can win here only
 * with version evidence), map-iteration-order ties (candidates are sorted
 * up front, and the sort orders output — it never converts a tie into an
 * accept), and authority outweighing identity (stars cannot overrule a
 * version match, only separate two of them).
 *
 * Deprecated versions still count as identity evidence: deprecation affects
 * whether we *recommend* a version, not whether the chart *came from* the
 * repository that published it.
 */

import type { ArtifactHubVersion } from "../db/schema/artifact-hub.js";
import { bestNewerTag } from "./image-tags.js";

/** Stars only decide a tie with a clear margin: winner ≥ RATIO × runner-up… */
export const STARS_MARGIN_RATIO = 5;
/** …and ≥ this many stars absolute, so 1-vs-0 is not a "clear margin". */
export const STARS_MARGIN_FLOOR = 50;

/** One distinct installed `(chartVersion, appVersion)` pair of a chart. */
export interface InstalledChartVersion {
    chartVersion: string | null;
    appVersion: string | null;
}

/** A mirror package pre-filtered by exact chart-name equality. */
export interface AttributionCandidate {
    packageId: string;
    repoName: string;
    repoUrl: string;
    stars: number;
    repoVerified: boolean;
    repoOfficial: boolean;
    versions: ArtifactHubVersion[];
}

export type AttributionRefusalReason =
    | "no-candidates"
    | "no-version-evidence"
    | "no-version-match"
    | "indistinguishable"
    | "conflicting-installs";

/** Per-candidate score breakdown, kept for the evidence record and debug logs. */
export interface CandidateScore {
    repoName: string;
    repoUrl: string;
    /** The installed chart version appears in this candidate's version list. */
    versionMatch: boolean;
    /** …and that version entry's `app` equals the installed app version. */
    appVersionMatch: boolean;
    repoVerified: boolean;
    repoOfficial: boolean;
    stars: number;
}

export interface AttributionEvidence {
    /** The installed pairs that carried evidence (null chart versions dropped). */
    installs: Array<{ chartVersion: string; appVersion: string | null }>;
    scores: CandidateScore[];
}

export type AttributionDecision =
    | { outcome: "matched"; candidate: AttributionCandidate; evidence: AttributionEvidence }
    | { outcome: "refused"; reason: AttributionRefusalReason; scores?: CandidateScore[] };

/**
 * Whether a chart reads as deprecated from its mirror package: the installed
 * version's entry is flagged, or the package's latest version is — the shape
 * chart-level deprecation takes in the dump. Callers must claim this only via
 * an attribution or an observed `repoUrl` that agrees with it, never a
 * name-only guess.
 */
export function isChartDeprecated(
    pkg: { versions: ArtifactHubVersion[]; latestVersion: string | null },
    installedVersion: string | null
): boolean {
    const entryFor = (version: string | null) =>
        version === null ? undefined : pkg.versions.find((v) => v.pkg === version);
    return entryFor(installedVersion)?.deprecated === true ||
        entryFor(pkg.latestVersion)?.deprecated === true;
}

/**
 * What the mirror knows about one installed release, as a surface may state it.
 *
 * The read-side counterpart to the matcher above: the attribution says *which*
 * package a chart is, this says what that package is worth telling a user —
 * that the match exists at all (with a link they can check), whether the hub
 * lists something newer, and whether the chart is deprecated.
 *
 * Everything here is **unmeasured**. "A newer version exists" is a listing, not
 * a release anyone here runs and nothing has scanned what it deploys — the same
 * rule `mirrorNewer` follows in the upgrade recommendation, and copy built on
 * this must never imply the bump fixes a known finding.
 */
export interface ArtifactHubMatch {
    /** Artifact Hub's repository slug. */
    repoName: string;
    /** The matched package's repository — `https://…` or `oci://…`. */
    repoUrl: string;
    /** The package's page on Artifact Hub, so the claim is checkable. */
    url: string;
    /**
     * The scanner observed no `repoUrl` and this match is what supplied one —
     * an inference, and the UI has to label it as one. `false` means the
     * observed repo and the matched package's agree, which is a fact.
     */
    inferred: boolean;
    /**
     * Newest non-deprecated version the mirror lists that orders above the
     * installed one. `null` = nothing newer, no installed version to compare,
     * or nothing comparable.
     */
    newerVersion: string | null;
    /** The package's latest listed version — context, never a recommendation. */
    latestVersion: string | null;
    /** The chart reads as deprecated in the package. */
    deprecated: boolean;
}

/**
 * Resolve one release against its chart's attribution.
 *
 * Returns `null` when there is nothing the evidence lets us say: no attribution
 * for the chart, or an attribution that speaks for a *different* repository
 * than the one the scanner observed on this release. That second case is the
 * one worth spelling out — an attribution is per `(org, chartName)`, so a
 * release whose observed repo disagrees with it is a different chart that
 * happens to share a name, and claiming the match would be exactly the
 * name-collision error `chartNameAmbiguous` exists to prevent.
 */
export function artifactHubMatch(
    release: { chartName: string | null; chartVersion: string | null; repoUrl: string | null },
    attribution:
        | {
              chartName: string;
              repoName: string;
              repoUrl: string;
              latestVersion: string | null;
              versions: ArtifactHubVersion[];
          }
        | undefined
): ArtifactHubMatch | null {
    if (!attribution || !release.chartName) return null;
    if (release.repoUrl !== null && release.repoUrl !== attribution.repoUrl) return null;

    // Deprecated versions are identity evidence but never a destination.
    const newerVersion = release.chartVersion
        ? bestNewerTag(
              release.chartVersion,
              attribution.versions.filter((v) => !v.deprecated).map((v) => v.pkg)
          ).best
        : null;

    return {
        repoName: attribution.repoName,
        repoUrl: attribution.repoUrl,
        url: `https://artifacthub.io/packages/helm/${encodeURIComponent(
            attribution.repoName
        )}/${encodeURIComponent(attribution.chartName)}`,
        inferred: release.repoUrl === null,
        newerVersion,
        latestVersion: attribution.latestVersion,
        deprecated: isChartDeprecated(attribution, release.chartVersion),
    };
}

function scoreCandidate(
    candidate: AttributionCandidate,
    install: { chartVersion: string; appVersion: string | null }
): CandidateScore {
    const entry = candidate.versions.find((v) => v.pkg === install.chartVersion);
    return {
        repoName: candidate.repoName,
        repoUrl: candidate.repoUrl,
        versionMatch: entry !== undefined,
        appVersionMatch:
            entry !== undefined && install.appVersion !== null && entry.app === install.appVersion,
        repoVerified: candidate.repoVerified,
        repoOfficial: candidate.repoOfficial,
        stars: candidate.stars,
    };
}

/**
 * Pick a winner among candidates that all carry version evidence, or refuse.
 * Each stage narrows; a stage that narrows to one decides. Stars are last and
 * only decide with a clear margin — see the constants above.
 */
function separate(scored: Array<{ candidate: AttributionCandidate; score: CandidateScore }>):
    | { candidate: AttributionCandidate }
    | { refused: "indistinguishable" } {
    let pool = scored;

    const narrow = (predicate: (s: CandidateScore) => boolean) => {
        const kept = pool.filter((entry) => predicate(entry.score));
        if (kept.length > 0) pool = kept;
    };

    narrow((s) => s.appVersionMatch);
    if (pool.length === 1) return { candidate: pool[0]!.candidate };
    narrow((s) => s.repoVerified);
    if (pool.length === 1) return { candidate: pool[0]!.candidate };
    narrow((s) => s.repoOfficial);
    if (pool.length === 1) return { candidate: pool[0]!.candidate };

    const byStars = [...pool].sort((a, b) => b.score.stars - a.score.stars);
    const [first, second] = [byStars[0]!, byStars[1]!];
    if (
        first.score.stars >= STARS_MARGIN_FLOOR &&
        first.score.stars >= STARS_MARGIN_RATIO * second.score.stars
    ) {
        return { candidate: first.candidate };
    }
    return { refused: "indistinguishable" };
}

/**
 * Attribute one `(org, chart)` group. `installs` is every distinct
 * `(chartVersion, appVersion)` pair the org runs of this chart — the unique
 * key forces one answer per group, so every pair that carries evidence must
 * agree on the winner.
 */
export function attributeChart(
    installs: InstalledChartVersion[],
    candidates: AttributionCandidate[]
): AttributionDecision {
    if (candidates.length === 0) return { outcome: "refused", reason: "no-candidates" };

    // Deterministic under any input order. This orders output and logs; the
    // separation stages never let it convert a tie into an accept.
    const sorted = [...candidates].sort((a, b) => a.repoName.localeCompare(b.repoName));

    const evidenced = installs.filter(
        (i): i is { chartVersion: string; appVersion: string | null } => i.chartVersion !== null
    );
    if (evidenced.length === 0) return { outcome: "refused", reason: "no-version-evidence" };

    const winners = new Map<string, AttributionCandidate>();
    const allScores: CandidateScore[] = [];

    for (const install of evidenced) {
        const scored = sorted.map((candidate) => ({
            candidate,
            score: scoreCandidate(candidate, install),
        }));
        allScores.push(...scored.map((s) => s.score));

        const withEvidence = scored.filter((s) => s.score.versionMatch);
        // Refusal-first: one installed version the mirror has never heard of
        // breaks the group's identity evidence — it is not skipped.
        if (withEvidence.length === 0) {
            return { outcome: "refused", reason: "no-version-match", scores: scored.map((s) => s.score) };
        }

        const result =
            withEvidence.length === 1 ? { candidate: withEvidence[0]!.candidate } : separate(withEvidence);
        if ("refused" in result) {
            return { outcome: "refused", reason: result.refused, scores: scored.map((s) => s.score) };
        }
        winners.set(result.candidate.packageId, result.candidate);
    }

    if (winners.size > 1) {
        return { outcome: "refused", reason: "conflicting-installs", scores: allScores };
    }

    const [winner] = winners.values();
    return {
        outcome: "matched",
        candidate: winner!,
        evidence: { installs: evidenced, scores: allScores },
    };
}
