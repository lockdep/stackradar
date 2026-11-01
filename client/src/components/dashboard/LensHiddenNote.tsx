'use client';

import { Tooltip } from '@/components/ui';
import {
    TIER_LENS_BUCKET_NAME,
    TIER_LENS_FINDINGS_LABEL,
    hiddenByLens,
    type TierCounts,
    type TierLens,
} from '@/lib/tier-lens';

/** What "unclassified" means here — the bucket neither lens lists, which only "All" counts. */
const UNCLASSIFIED_PACKAGES_HINT =
    'Packages StackRadar has not yet sorted into application or base image; they are counted under All.';

/**
 * What the exposure strip's lens is leaving out, said on the strip itself:
 * "Showing application findings · 97 critical in base images and unclassified
 * packages hidden · Show all". The default lens hides the base image's
 * findings by design, and the strip's Critical card is the number a reader
 * quotes — so the strip, not a footer three blocks down, is where the hidden
 * count has to be. Silent under "All findings", and when no critical finding
 * is outside the lens. `counts` are the critical findings per bucket, from
 * the same response the cards count from.
 */
export function LensHiddenNote({
    lens,
    counts,
    onShowAll,
}: {
    lens: TierLens;
    counts: TierCounts | undefined;
    /** Switches the page's lens to "All findings". */
    onShowAll: () => void;
}) {
    if (lens === 'all' || !counts) return null;
    const gap = hiddenByLens(counts, lens);
    if (!gap) return null;
    /* "Unclassified" is the strip's one word with no page behind it, so it
       carries its definition; the bucket names are the lens's own words. */
    const unclassified = (
        <Tooltip text={UNCLASSIFIED_PACKAGES_HINT} align="start">
            unclassified packages
        </Tooltip>
    );
    const where =
        gap.unclassified > 0 ? (
            gap.inOther > 0 ? (
                <>
                    {TIER_LENS_BUCKET_NAME[gap.other]} and {unclassified}
                </>
            ) : (
                unclassified
            )
        ) : (
            TIER_LENS_BUCKET_NAME[gap.other]
        );
    return (
        <p className="mt-2 text-xs text-ink-muted">
            Showing {TIER_LENS_FINDINGS_LABEL[lens].toLowerCase()}
            <span aria-hidden="true"> · </span>
            <span className="text-ink-secondary">
                {gap.hidden.toLocaleString()} critical in {where} hidden
            </span>
            <span aria-hidden="true"> · </span>
            <button type="button" onClick={onShowAll} className="cursor-pointer text-accent hover:underline">
                Show all
            </button>
        </p>
    );
}
