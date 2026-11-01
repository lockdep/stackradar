'use client';

import type { ReactNode } from 'react';
import { SeveritySparkline, severityDotClass, type SeverityKey } from './SeveritySparkline';
import type { MetricsSnapshot } from './MetricsChartCard';
import { StatPanel, type StatCell } from './StatPanel';

const SEVERITY_KEY = {
    critical: 'criticalVulnerabilities',
    high: 'highVulnerabilities',
    medium: 'mediumVulnerabilities',
    low: 'lowVulnerabilities',
} as const satisfies Record<SeverityKey, keyof MetricsSnapshot>;

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export interface SeverityCardsProps {
    snapshots: MetricsSnapshot[];
    /** Live counts to display instead of the latest snapshot values. Deltas and sparklines always come from snapshots. */
    counts?: Record<SeverityKey, number>;
    /**
     * Makes each card a "see all" link to the list its count summarises —
     * the cluster Overview points these at its Vulnerabilities tab, the org
     * Dashboard at the org-wide `/vulnerabilities` page, each with the
     * matching severity filter.
     */
    severityHref?: (severity: SeverityKey) => string;
    /**
     * The live counts are still on their way: the four cards are drawn with
     * their labels and a placeholder figure, so the strip holds its place
     * instead of arriving a beat after the blocks around it. Nothing from
     * `snapshots` stands in for a count — the hourly numbers are not the
     * live ones.
     */
    pending?: boolean;
    /** A chip beside the heading saying what the counts are under (the page's lens and image scope). */
    scope?: ReactNode;
    /** The heading's `id`, for a section labelled by it. */
    titleId?: string;
}

/* No `action` slot on purpose. It existed only to host the cluster tab's
   `DaysFilter`, which put a control that scopes the trend charts *below* this panel
   inside this panel's own header. The filter now sits in one row above everything
   it scopes; re-adding a slot here would invite it straight back. `scope` is
   not a control: it says what the filters are, it does not set them. */
export function SeverityCards({
    snapshots,
    counts,
    severityHref,
    pending = false,
    scope,
    titleId,
}: SeverityCardsProps) {
    const latest = snapshots.at(-1);
    const earliest = snapshots[0];
    if (!latest && !counts && !pending) return null;
    const hasTrend = snapshots.length > 1;

    const cells: StatCell[] = SEVERITIES.map((severity) => {
        const key = SEVERITY_KEY[severity];
        const value = counts ? counts[severity] : latest ? latest[key] : 0;
        return {
            key: severity,
            label: severity,
            value,
            pending,
            /* Measured from the displayed value, not from the latest snapshot:
               with live `counts` the two are different numbers, and a delta that
               subtracts one pair while labelling another is the same
               state-from-history mistake in miniature. */
            delta: hasTrend && !pending ? value - earliest[key] : undefined,
            dotClass: severityDotClass[severity],
            sparkline: hasTrend ? <SeveritySparkline data={snapshots} severity={severity} height={36} /> : undefined,
            href: severityHref?.(severity),
            hrefTitle: severityHref ? `See all ${severity} vulnerabilities` : undefined,
        };
    });

    return (
        <StatPanel
            title="Current vulnerability exposure"
            titleId={titleId}
            titleAside={scope}
            cells={cells}
            variant="cards"
        />
    );
}
