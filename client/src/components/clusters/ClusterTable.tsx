'use client';

import { useId } from 'react';
import Link from 'next/link';
import { ChevronRight, KeyRound } from 'lucide-react';
import type { Cluster } from '@/types/cluster';
import { useNow } from '@/hooks';
import { formatRelativeTime } from '@/utils/formatters';
import {
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
    RiskCell,
} from '@/components/ui';
import { ScannerDot, getScannerHealth } from './ScannerDot';
import { coverageHref } from './RegistryAuthBanner';

export function AwaitingBadge() {
    const tooltipId = useId();
    return (
        <span className="relative group/awaiting inline-flex shrink-0">
            <span
                tabIndex={0}
                aria-describedby={tooltipId}
                className="inline-flex items-center gap-1 rounded-full bg-attention-subtle px-2 py-0.5 text-[11px] font-medium text-attention ring-1 ring-inset ring-attention-muted cursor-help focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
            >
                Awaiting data
            </span>
            <div
                id={tooltipId}
                role="tooltip"
                className="absolute left-0 top-full mt-1.5 z-50 hidden group-hover/awaiting:block group-focus-within/awaiting:block w-64 rounded-md bg-ink px-3 py-2 text-xs text-surface shadow-floating pointer-events-auto"
            >
                <p>The scanner hasn&apos;t connected yet. Run the Helm install command to get started.</p>
            </div>
        </span>
    );
}

/**
 * The one coverage gap that never closes on its own. Same shape as the
 * awaiting badge, but red and a link: the row's click opens the cluster, and
 * this goes one step further — to the Coverage card carrying the fix.
 */
export function AuthFailedBadge({ cluster }: { cluster: Cluster }) {
    const tooltipId = useId();
    const n = cluster.registryAuthFailedWorkloads;
    const hosts = cluster.registryAuthFailedHosts.join(', ');
    return (
        <span className="relative group/authfailed inline-flex shrink-0">
            <Link
                href={coverageHref(cluster.id)}
                onClick={(e) => e.stopPropagation()}
                aria-describedby={tooltipId}
                className="inline-flex items-center gap-1 rounded-full bg-danger-subtle px-2 py-0.5 text-[11px] font-medium text-danger ring-1 ring-inset ring-danger-muted hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
            >
                <KeyRound aria-hidden="true" className="size-3" />
                Registry auth failed
            </Link>
            <div
                id={tooltipId}
                role="tooltip"
                className="absolute left-0 top-full mt-1.5 z-50 hidden group-hover/authfailed:block group-focus-within/authfailed:block w-64 rounded-md bg-ink px-3 py-2 text-xs text-surface shadow-floating pointer-events-auto"
            >
                <p>
                    The scanner cannot authenticate to {hosts || 'a private registry'}, so{' '}
                    {n === 1 ? 'one container has' : `${n} containers have`} no SBOM. Open the cluster&apos;s Coverage
                    card for the fix.
                </p>
            </div>
        </span>
    );
}

export function ClusterTable({
    clusters,
    workloadCountsByCluster,
    onSelect,
}: {
    clusters: Cluster[];
    workloadCountsByCluster: Record<string, number> | null;
    onSelect: (cluster: Cluster) => void;
}) {
    // Re-renders on a schedule so the scanner age and dot stay truthful.
    useNow();
    return (
        <TableContainer className="mt-6">
            <Table aria-label="Clusters">
                <TableHead>
                    <TableHeader>Name</TableHeader>
                    <TableHeader>Containers</TableHeader>
                    <TableHeader>Risk Score</TableHeader>
                    {/* Name, Containers and Risk Score are the row on a
                        phone; the scanner's state folds into the Name cell
                        there. Version and Created wait for the sidebar
                        layout. */}
                    <TableHeader hideBelow="md">Scanner</TableHeader>
                    <TableHeader hideBelow="lg">Version</TableHeader>
                    <TableHeader hideBelow="lg">Created</TableHeader>
                    <TableHeader srOnly>Open</TableHeader>
                </TableHead>
                <TableBody>
                    {clusters.map((cluster) => {
                        const workloadCount = workloadCountsByCluster?.[cluster.id];
                        const isEmpty = typeof workloadCount === 'number' && workloadCount === 0;
                        const health = getScannerHealth(cluster.scannerLastSeenAt);
                        const scannerLabel = cluster.scannerLastSeenAt
                            ? formatRelativeTime(cluster.scannerLastSeenAt)
                            : 'Waiting to connect';

                        return (
                            <TableRow key={cluster.id} onClick={() => onSelect(cluster)} className="group">
                                <TableCell>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onSelect(cluster);
                                            }}
                                            className="text-xs sm:text-sm font-medium text-ink text-left cursor-pointer rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                        >
                                            {cluster.name}
                                        </button>
                                        {isEmpty && <AwaitingBadge />}
                                        {cluster.registryAuthFailedWorkloads > 0 && (
                                            <AuthFailedBadge cluster={cluster} />
                                        )}
                                    </div>
                                    {cluster.description && (
                                        <p className="mt-0.5 truncate max-w-xs text-xs text-ink-muted">
                                            {cluster.description}
                                        </p>
                                    )}
                                    {/* The Scanner column, folded in while it is
                                        collapsed: "waiting to connect" is the one
                                        state a phone reader needs. */}
                                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted md:hidden">
                                        <ScannerDot health={health} />
                                        {scannerLabel}
                                    </span>
                                </TableCell>
                                <TableCell className="text-ink-secondary">
                                    {typeof workloadCount === 'number' ? workloadCount : '—'}
                                </TableCell>
                                <TableCell>
                                    {/* A dash until something is scanned: a cluster's
                                        total of 0 is a claim ("checked, clean"), and an
                                        unscanned cluster has earned no claim. Findings
                                        alone are also enough — a scanner too old to
                                        report inventory leaves `scannedWorkloads` null
                                        while SBOMs and findings exist. */}
                                    <RiskCell
                                        risk={
                                            cluster.risk.findingCount > 0 || cluster.scannedWorkloads
                                                ? cluster.risk
                                                : null
                                        }
                                    />
                                </TableCell>
                                <TableCell hideBelow="md">
                                    <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                                        <ScannerDot health={health} />
                                        {scannerLabel}
                                    </span>
                                </TableCell>
                                <TableCell hideBelow="lg">
                                    {cluster.scannerVersion ? (
                                        <span className="inline-flex items-center rounded-sm bg-surface-hover px-1.5 py-0.5 text-xs font-mono text-ink-secondary">
                                            {cluster.scannerVersion}
                                        </span>
                                    ) : (
                                        <span className="text-xs text-ink-muted">—</span>
                                    )}
                                </TableCell>
                                <TableCell hideBelow="lg" className="text-xs text-ink-muted">
                                    {formatRelativeTime(cluster.createdAt)}
                                </TableCell>
                                <TableCell align="end">
                                    <ChevronRight
                                        className="ml-auto size-4 text-ink-faint group-hover:text-ink-secondary"
                                        aria-hidden="true"
                                    />
                                </TableCell>
                            </TableRow>
                        );
                    })}
                </TableBody>
            </Table>
        </TableContainer>
    );
}
