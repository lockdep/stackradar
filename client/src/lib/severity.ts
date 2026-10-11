/**
 * Severity buckets and the noise filter for finding lists.
 *
 * A finding's `severityLevel` is one of the four CVSS bands, or it is
 * *unscored*: the advisory's publisher gave it no CVSS vector and no severity
 * label anywhere the OSV schema allows one (the server's `extractSeverity`
 * reads every such place before it gives up, so "unscored" here really does
 * mean "nobody scored it"). The mirror spells that `unknown`; the UI never
 * shows that word, because it reads as "we broke something" rather than "the
 * source published nothing".
 *
 * Unscored findings are noise most of the time — distro tracker entries for
 * bugs nobody has triaged — so the list hides them by default. The one case
 * they must stay visible is when something *else* says the flaw matters: a
 * CISA KEV listing, or an EPSS score high enough that exploitation is likely.
 * Hiding an exploited vulnerability because its publisher never filled in a
 * CVSS field would be the worst possible outcome of a noise filter.
 */

export const SEVERITY_BANDS = ['critical', 'high', 'medium', 'low'] as const;
export type SeverityBand = (typeof SEVERITY_BANDS)[number];
export type SeverityBucket = SeverityBand | 'unscored';

export const UNSCORED_LABEL = 'Unscored';
export const UNSCORED_HINT =
    'The advisory source published no CVSS score or severity for this finding. It still contributes to the Radar Score at a neutral CVSS of 4.0, and is shown here because it is exploited (CISA KEV) or likely to be (EPSS).';
export const UNSCORED_HIDDEN_HINT =
    'Advisories whose source published no CVSS score or severity. Hidden by default; exploited ones (CISA KEV, or EPSS ≥ 10%) are always shown.';

/**
 * EPSS probability above which an unscored finding is shown regardless of the
 * filter. 0.1 (a 10% chance of exploitation in the next 30 days) sits around
 * the 90th percentile of all CVEs — the conventional "take this seriously"
 * line, and well above the 0.0004 median.
 */
export const EXPLOITED_EPSS_THRESHOLD = 0.1;

export function severityBucket(level: string | null | undefined): SeverityBucket {
    switch (level?.toLowerCase()) {
        case 'critical':
            return 'critical';
        case 'high':
            return 'high';
        case 'medium':
            return 'medium';
        case 'low':
            return 'low';
        default:
            return 'unscored';
    }
}

export function isUnscored(level: string | null | undefined): boolean {
    return severityBucket(level) === 'unscored';
}

type ExploitSignals = {
    kevListedAt?: string | Date | null;
    epssScore?: number | null;
};

/** True when KEV or EPSS says this is exploited or likely to be. */
export function hasExploitEvidence(v: ExploitSignals): boolean {
    if (v.kevListedAt != null) return true;
    return (v.epssScore ?? 0) >= EXPLOITED_EPSS_THRESHOLD;
}

export type SeverityFilter = {
    /** Which of the four bands to show. */
    bands: ReadonlySet<SeverityBand>;
    /** Whether to show unscored findings that carry no exploit evidence. */
    includeUnscored: boolean;
};

export const DEFAULT_SEVERITY_FILTER: SeverityFilter = {
    bands: new Set(SEVERITY_BANDS),
    includeUnscored: false,
};

type Filterable = ExploitSignals & { severityLevel?: string | null };

export type FilterResult<T> = {
    /** What to render: scored findings in their incoming order, then unscored. */
    shown: T[];
    /** Unscored findings the filter dropped — surfaced as "N hidden" so the cut is visible. */
    hiddenUnscored: number;
};

/**
 * Apply a {@link SeverityFilter}. Stable: scored rows keep their incoming
 * (server, risk-ordered) order; unscored rows that survive are moved after
 * them so a list never opens on a row that cannot say how bad it is.
 */
export function filterBySeverity<T extends Filterable>(vulns: readonly T[], filter: SeverityFilter): FilterResult<T> {
    const scored: T[] = [];
    const unscored: T[] = [];
    let hiddenUnscored = 0;

    for (const v of vulns) {
        const bucket = severityBucket(v.severityLevel);
        if (bucket === 'unscored') {
            if (filter.includeUnscored || hasExploitEvidence(v)) unscored.push(v);
            else hiddenUnscored++;
        } else if (filter.bands.has(bucket)) {
            scored.push(v);
        }
    }

    return { shown: [...scored, ...unscored], hiddenUnscored };
}
