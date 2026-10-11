'use client';

import { Spinner, TableCell, TableRow, TierLensControl, TierLensEmpty } from '@/components/ui';
import type { TierCounts, TierLens } from '@/lib/tier-lens';
import { FindingsTable } from './FindingsTable';
import type { ClusterRadarScoreFinding } from '@/types/cluster';

/** One image's findings fetch, cached for the session once loaded. */
export type FindingsEntry =
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'loaded'; findings: ClusterRadarScoreFinding[]; tierCounts?: TierCounts | undefined };

/**
 * The expanded row under an image on the Radar Score tab: every finding that
 * adds up to the image's share, largest contribution first, each with the
 * public inputs its contribution was computed from.
 *
 * The list is the working behind the number — the reason the Radar Score is
 * an argument rather than a verdict. The image's row shows the sum; this shows
 * the addends, and the first few rows explain most of it.
 */
export function RadarScoreFindingsRow({
    imageLabel,
    score,
    entry,
    lens,
    onLensChange,
    onRetry,
    colSpan = 6,
}: {
    imageLabel: string;
    score: number;
    entry: FindingsEntry | undefined;
    lens: TierLens;
    onLensChange: (lens: TierLens) => void;
    onRetry: () => void;
    /** The parent table's column count — one more on the org page, for the Cluster column. */
    colSpan?: number;
}) {
    return (
        <TableRow>
            <TableCell
                colSpan={colSpan}
                className="bg-surface-muted/80 pl-6 pr-2 sm:pl-10 sm:pr-3 border-t border-edge"
            >
                {!entry || entry.status === 'loading' ? (
                    <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
                        <Spinner size="sm" className="text-ink-faint" />
                        Loading findings...
                    </span>
                ) : entry.status === 'error' ? (
                    <span className="inline-flex items-center gap-2 text-sm text-ink-muted">
                        Could not load the findings for {imageLabel}.
                        <button
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRetry();
                            }}
                            className="cursor-pointer text-accent underline underline-offset-2"
                        >
                            Try again
                        </button>
                    </span>
                ) : (
                    <FindingsList
                        findings={entry.findings}
                        tierCounts={entry.tierCounts}
                        score={score}
                        imageLabel={imageLabel}
                        lens={lens}
                        onLensChange={onLensChange}
                    />
                )}
            </TableCell>
        </TableRow>
    );
}

function FindingsList({
    findings,
    tierCounts,
    score,
    imageLabel,
    lens,
    onLensChange,
}: {
    findings: ClusterRadarScoreFinding[];
    tierCounts: TierCounts | undefined;
    score: number;
    imageLabel: string;
    lens: TierLens;
    onLensChange: (lens: TierLens) => void;
}) {
    const total = tierCounts?.all ?? findings.length;
    if (total === 0) {
        return (
            <span className="text-sm text-ink-muted">
                No findings match this image any more — the list may be stale. Refresh to re-check.
            </span>
        );
    }

    /* Under a lens the rows are some of the addends, so the sentence says
       which share of the image's score they are rather than claiming the sum. */
    const shownScore = findings.reduce((sum, f) => sum + (f.riskScore ?? 0), 0);
    const partial = findings.length < total;

    return (
        <div className="py-1.5" onClick={(e) => e.stopPropagation()}>
            <TierLensControl lens={lens} onChange={onLensChange} counts={tierCounts} className="mb-2" />
            {findings.length === 0 ? (
                <p className="text-sm text-ink-muted">
                    <TierLensEmpty lens={lens} counts={tierCounts} onChange={onLensChange} />
                </p>
            ) : (
                <p className="mb-2 text-xs text-ink-muted">
                    {partial ? (
                        <>
                            {findings.length.toLocaleString()} of {total.toLocaleString()} findings, contributing{' '}
                            <span className="font-semibold tabular-nums text-ink">
                                {Math.round(shownScore).toLocaleString()}
                            </span>{' '}
                            of this image&apos;s {Math.round(score).toLocaleString()}.
                        </>
                    ) : (
                        <>
                            {findings.length.toLocaleString()} {findings.length === 1 ? 'finding adds' : 'findings add'}{' '}
                            up to{' '}
                            <span className="font-semibold tabular-nums text-ink">
                                {Math.round(score).toLocaleString()}
                            </span>
                            .
                        </>
                    )}{' '}
                    Each row is one advisory on one package; its contribution is CVSS weighted by EPSS likelihood,
                    raised to the maximum for CISA KEV findings.
                </p>
            )}
            {findings.length > 0 && <FindingsTable findings={findings} aria-label={`Findings in ${imageLabel}`} />}
        </div>
    );
}
