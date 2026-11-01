/**
 * The findings lens — "Application · Base image · All".
 *
 * A lens is a default view, never a verdict: it decides what a findings table
 * shows first, the counts for every bucket stay on the control, and findings
 * on CISA KEV or with EPSS ≥ 0.1 are listed under every lens (the server
 * marks them `shownDespiteTier`). The server owns all of that
 * (`server/src/db/finding-tier.ts`); this module is the client's vocabulary.
 *
 * "tier", "os" and "runtime" are the API's words and stay out of copy: the UI
 * says "Application", "Base image" and "All".
 */

export type TierLens = 'application' | 'base' | 'all';

export const TIER_LENSES: readonly TierLens[] = ['application', 'base', 'all'];

export const TIER_LENS_LABEL: Record<TierLens, string> = {
    application: 'Application',
    base: 'Base image',
    all: 'All',
};

/** The lens as the filter bar's "Findings" menu spells it, and as the blocks it scopes repeat it. */
export const TIER_LENS_FINDINGS_LABEL: Record<TierLens, string> = {
    application: 'Application findings',
    base: 'Base image findings',
    all: 'All findings',
};

/** Where a lens's findings live, in a sentence: "in application packages", "in base images". */
export const TIER_LENS_BUCKET_NAME: Record<Exclude<TierLens, 'all'>, string> = {
    application: 'application packages',
    base: 'base images',
};

export const TIER_LENS_HINT: Record<TierLens, string> = {
    application: 'Dependencies your build added. Exploited findings in the base image are always shown.',
    base: 'Operating-system packages and the tooling that ships with the language (npm, pip, the JDK) — fixed by rebuilding on a newer base image.',
    all: 'Every finding, in application packages and in the base image.',
};

/** The muted label on a row the lens would have folded and the server kept. */
export const SHOWN_DESPITE_LENS_LABEL: Record<Exclude<TierLens, 'all'>, string> = {
    application: 'Base image · exploited',
    base: 'Application · exploited',
};

/** What `?tier=` carries to the API for each lens; `all` sends nothing. */
const API_TIER: Record<TierLens, string | null> = {
    application: 'application,main',
    base: 'os,runtime',
    all: null,
};

export function apiTierParam(lens: TierLens): string | null {
    return API_TIER[lens];
}

/** Adds `tier=` to a query being built, when the lens has one. */
export function withTierParam(params: URLSearchParams, lens: TierLens): URLSearchParams {
    const value = API_TIER[lens];
    if (value) params.set('tier', value);
    return params;
}

export type TierCounts = { application: number; base: number; all: number };

/** The third bucket's name where the menu lists it beside the two lenses. */
export const TIER_LENS_UNCLASSIFIED_LABEL = 'Unclassified findings';

export const TIER_LENS_UNCLASSIFIED_HINT =
    'Packages no scan has placed in the application or the base image yet. Listed under All findings only.';

/**
 * Findings in neither lens bucket — packages whose tier is unknown — which
 * only "All" lists. Named so Application + Base image + Unclassified = All
 * on the control that offers the three; without it the two lenses visibly
 * fail to add up and the gap reads as a bug.
 */
export function unclassifiedFindings(counts: TierCounts): number {
    return Math.max(0, counts.all - counts.application - counts.base);
}

/**
 * What a lens leaves out of a count: the findings in the other bucket, and
 * the ones in packages no scan has classified yet, which neither lens lists.
 * Null under "All", and when nothing is outside the lens — the two cases a
 * block has nothing to say about. Exploited findings pass every lens and are
 * still counted here: the number is the bucket's, not the list's.
 */
export function hiddenByLens(
    counts: TierCounts,
    lens: TierLens,
): { hidden: number; other: Exclude<TierLens, 'all'>; inOther: number; unclassified: number } | null {
    if (lens === 'all') return null;
    const hidden = counts.all - counts[lens];
    if (hidden <= 0) return null;
    const other = lens === 'application' ? 'base' : 'application';
    return { hidden, other, inOther: counts[other], unclassified: hidden - counts[other] };
}

export function isTierLens(value: string | null | undefined): value is TierLens {
    return value != null && (TIER_LENSES as readonly string[]).includes(value);
}

/** The page-URL parameter. The value is the lens name, not the API's tier list. */
export const TIER_LENS_PARAM = 'tier';

/**
 * Which lens a page shows: the URL, then the reader's last explicit choice,
 * then the page's fallback. A hand-edited or stale value degrades to the
 * next source rather than throwing.
 */
export function resolveLens(
    param: string | null | undefined,
    stored: string | null | undefined,
    fallback: TierLens = 'application',
): TierLens {
    if (isTierLens(param)) return param;
    if (isTierLens(stored)) return stored;
    return fallback;
}

/**
 * The page URL for a chosen lens. The default is written too: it is per
 * reader, so a link that left it out would show its recipient another list.
 */
export function lensHref(pathname: string, search: string, lens: TierLens): string {
    const params = new URLSearchParams(search);
    params.set(TIER_LENS_PARAM, lens);
    return `${pathname}?${params}`;
}

const STORAGE_KEY = 'sr.findings-lens';

/** The reader's last explicit choice. Storage can throw (private mode, blocked site data). */
export function readStoredLens(): TierLens | null {
    try {
        const value = window.localStorage.getItem(STORAGE_KEY);
        return isTierLens(value) ? value : null;
    } catch {
        return null;
    }
}

export function storeLens(lens: TierLens): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, lens);
    } catch {
        /* A lens that is not remembered is still a lens. */
    }
}
