'use client';

import { Fragment, useEffect } from 'react';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { PackageTypeBadge, TableBody, TableCell, TableRow, VulnerabilityCounts } from '@/components/ui';
import { PackageExpandedPanel, packageLabel } from './PackageExpandedPanel';
import { PackageOccurrencesPopover } from './PackageOccurrencesPopover';
import { VulnerabilityDetailRow } from './VulnerabilityDetailRow';
import { packageRowKey } from './package-focus';
import { CONTROL_FILTER_PARAM, type ControlFilter } from '@/lib/image-control';
import type { ClusterPackagesResponse } from '@/types/cluster';

type Package = ClusterPackagesResponse['packages'][number];

/** The DOM id of one row, for the deep link's scroll — any string is a valid id, `getElementById` reads it back. */
function rowDomId(rowKey: string): string {
    return `package-row-${encodeURIComponent(rowKey)}`;
}

type Props = {
    packages: Package[];
    /** The list endpoint; `/occurrences` hangs off it. */
    apiBase: string;
    /** Keys expansion with the row's identity — the list's state, so a cluster switch keeps it. */
    contextKey: string;
    /** Set on a cluster tab; absent on the org-wide list, where rows span clusters. */
    clusterId?: string;
    control: ControlFilter;
    showClusters: boolean;
    /** Open rows, keyed `contextKey|rowKey`. */
    expanded: ReadonlySet<string>;
    onToggle: (rowKey: string) => void;
    /** The row a deep link means, scrolled into view once it is on the page. */
    scrollToKey?: string | null;
};

/**
 * The rows of a package list: one per `name@version`, each unfolding in
 * place to `PackageExpandedPanel` — the images and containers behind its
 * counts, with links — the way the vulnerability list's rows unfold. The
 * header is the list's; every cell carries the same `hideBelow` as its
 * header, or the rows shift under it.
 *
 * A click on the row toggles it. The count cells keep their popovers and
 * stop the click, so the one interactive row never has two meanings for one
 * click — and a link inside an open popover, which React bubbles through
 * the portal, does not fold the row it was opened from.
 */
export function PackageRows({
    packages,
    apiBase,
    contextKey,
    clusterId,
    control,
    showClusters,
    expanded,
    onToggle,
    scrollToKey,
}: Props) {
    useEffect(() => {
        if (!scrollToKey) return;
        document.getElementById(rowDomId(scrollToKey))?.scrollIntoView({ block: 'center' });
    }, [scrollToKey]);

    return (
        <TableBody>
            {packages.map((pkg) => {
                const rowKey = packageRowKey(pkg.name, pkg.version);
                const isExpanded = expanded.has(`${contextKey}|${rowKey}`);
                const label = packageLabel(pkg);
                /* Under the list's images filter, so the panel lists what the counts counted. */
                const params = new URLSearchParams({ name: pkg.name });
                if (pkg.version !== null) params.set('version', pkg.version);
                if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control);
                const occurrencesUrl = `${apiBase}/occurrences?${params}`;
                const stop = (e: React.SyntheticEvent) => e.stopPropagation();

                return (
                    <Fragment key={rowKey}>
                        <TableRow id={rowDomId(rowKey)} onClick={() => onToggle(rowKey)} aria-expanded={isExpanded}>
                            <TableCell className="w-7 pl-3 pr-0 text-ink-faint">
                                {/* The row is the tab stop (`TableRow`); the chevron stays for the pointer. */}
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-hidden="true"
                                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} details for ${label}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onToggle(rowKey);
                                    }}
                                    className="cursor-pointer rounded-sm p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                >
                                    {isExpanded ? (
                                        <ChevronDown aria-hidden="true" className="size-3.5" />
                                    ) : (
                                        <ChevronRight aria-hidden="true" className="size-3.5" />
                                    )}
                                </button>
                            </TableCell>
                            <TableCell>
                                <span className="inline-flex flex-wrap items-center gap-1.5">
                                    <span className="font-medium text-ink break-all" title={pkg.purl ?? undefined}>
                                        {pkg.name}
                                    </span>
                                    {pkg.packageType && <PackageTypeBadge packageType={pkg.packageType} />}
                                </span>
                                {/* The Version column, folded in while it is
                                    collapsed — the row is one name + version,
                                    so it cannot go. */}
                                {pkg.version && (
                                    <span className="mt-0.5 block font-mono text-xs text-ink-muted break-all sm:hidden">
                                        {pkg.version}
                                    </span>
                                )}
                            </TableCell>
                            <TableCell hideBelow="sm" className="font-mono text-xs text-ink-secondary">
                                {pkg.version ?? <span className="text-ink-muted">—</span>}
                            </TableCell>
                            <TableCell hideBelow="lg" className="text-xs text-ink-secondary">
                                {pkg.license ?? <span className="text-ink-muted">—</span>}
                            </TableCell>
                            {/* The count cells are links (accent, underline on
                                hover) to the popover behind them; the click is
                                theirs, not the row's. */}
                            <TableCell hideBelow="md" align="end" className="tabular-nums" onClick={stop}>
                                <PackageOccurrencesPopover
                                    clusterId={clusterId}
                                    packageName={pkg.name}
                                    version={pkg.version}
                                    kind="images"
                                    control={control}
                                    count={pkg.imageCount}
                                />
                            </TableCell>
                            <TableCell hideBelow="md" align="end" className="tabular-nums" onClick={stop}>
                                {/* 0 is "scanned but not in any inventory yet",
                                    and a dash says "not running" less loudly
                                    than a zero says "you have a problem". */}
                                {pkg.containerCount > 0 ? (
                                    <PackageOccurrencesPopover
                                        clusterId={clusterId}
                                        packageName={pkg.name}
                                        version={pkg.version}
                                        kind="containers"
                                        control={control}
                                        count={pkg.containerCount}
                                    />
                                ) : (
                                    <span className="text-ink-muted">—</span>
                                )}
                            </TableCell>
                            {showClusters && (
                                <TableCell hideBelow="lg" align="end" className="tabular-nums text-ink-secondary">
                                    {/* No popover of its own: the image and
                                        container popovers already name each
                                        hit's cluster, and the expanded row
                                        lists them. */}
                                    <span title="Clusters with at least one image carrying this version">
                                        {pkg.clusterCount}
                                    </span>
                                </TableCell>
                            )}
                            <TableCell align="end">
                                <span className="inline-flex items-center justify-end gap-1.5">
                                    {/* The aggregate risk chip's marker, with its meaning. */}
                                    {pkg.kevCount > 0 && (
                                        <span
                                            title={`${pkg.kevCount} confirmed exploited in the wild (CISA KEV)`}
                                            className="inline-flex shrink-0 text-danger"
                                        >
                                            <ShieldAlert aria-hidden="true" className="size-3.5" />
                                            <span className="sr-only">{pkg.kevCount} on CISA KEV</span>
                                        </span>
                                    )}
                                    <VulnerabilityCounts {...pkg.vulnCounts} />
                                </span>
                            </TableCell>
                        </TableRow>
                        {isExpanded && (
                            <VulnerabilityDetailRow>
                                <PackageExpandedPanel
                                    pkg={pkg}
                                    occurrencesUrl={occurrencesUrl}
                                    showClusters={showClusters}
                                />
                            </VulnerabilityDetailRow>
                        )}
                    </Fragment>
                );
            })}
        </TableBody>
    );
}
