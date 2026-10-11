'use client';

import { RefreshCw, ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Clock, Package } from 'lucide-react';
import {
    ErrorBlock,
    LoadingBlock,
    VulnerabilitySquare,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui';
import { useResource } from '@/hooks';
import { formatDate, formatDuration, formatRelativeTime } from '@/utils/formatters';
import type { OsvSyncTabProps, ScanRunItem } from './types';

const TRIGGER_LABELS: Record<string, string> = {
    manual: 'Manual',
    sbom_upload: 'SBOM upload',
    schedule: 'Scheduled',
    system: 'System',
};

function StatusBadge({ status }: { status: ScanRunItem['status'] }) {
    if (status === 'success') {
        return (
            <span className="inline-flex items-center gap-1 text-sm text-success">
                <CheckCircle2 className="size-4" />
                Success
            </span>
        );
    }
    if (status === 'partial') {
        return (
            <span className="inline-flex items-center gap-1 text-sm text-attention">
                <AlertTriangle className="size-4" />
                Partial
            </span>
        );
    }
    return (
        <span className="inline-flex items-center gap-1 text-sm text-danger">
            <XCircle className="size-4" />
            Failed
        </span>
    );
}

export function OsvSyncTab({ containerId }: OsvSyncTabProps) {
    /* Retry re-enters the loading state, as the tab always did. */
    const {
        data,
        isLoading,
        error,
        refetch: fetchRuns,
    } = useResource<ScanRunItem[]>(`/api/containers/${containerId}/scan-history`, {
        responseError: () => 'Failed to fetch scan history',
        fallbackError: 'Failed to fetch scan history',
        loadingOnRefetch: true,
    });
    const runs = data ?? [];

    if (isLoading) {
        return <LoadingBlock label="Loading scan history..." />;
    }

    if (error) {
        return (
            <ErrorBlock
                title="Failed to load scan history"
                message={error}
                icon={<XCircle className="size-6 text-danger" />}
                onRetry={fetchRuns}
            />
        );
    }

    if (runs.length === 0) {
        return (
            <div className="text-center py-12">
                <ShieldCheck className="mx-auto size-12 text-ink-faint/70" />
                <h3 className="mt-2 text-sm font-semibold text-ink">No scans yet</h3>
                <p className="mt-1 text-sm text-ink-muted max-w-sm mx-auto">
                    Each time this image&apos;s SBOM is scanned against the OSV mirror, the run will appear here.
                </p>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm text-ink-muted">
                    {runs.length} scan{runs.length !== 1 ? 's' : ''} against the OSV mirror
                </p>
                <button
                    onClick={fetchRuns}
                    className="inline-flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink cursor-pointer"
                >
                    <RefreshCw className="size-4" />
                    Refresh
                </button>
            </div>

            <TableContainer variant="section">
                <Table aria-label="Scan runs">
                    <TableHead>
                        <TableHeader>Status</TableHeader>
                        <TableHeader hideBelow="md">Trigger</TableHeader>
                        <TableHeader hideBelow="lg">Components</TableHeader>
                        <TableHeader>Vulnerabilities</TableHeader>
                        <TableHeader hideBelow="lg">Mirror data</TableHeader>
                        <TableHeader hideBelow="xl">Duration</TableHeader>
                        <TableHeader align="end">When</TableHeader>
                    </TableHead>
                    <TableBody>
                        {runs.map((run) => (
                            <TableRow key={run.id} className="align-top">
                                <TableCell className="whitespace-nowrap">
                                    <StatusBadge status={run.status} />
                                    {run.errorMessage && (
                                        <p
                                            className="mt-1 max-w-40 truncate text-xs text-danger sm:max-w-xs"
                                            title={run.errorMessage}
                                        >
                                            {run.errorMessage}
                                        </p>
                                    )}
                                </TableCell>
                                <TableCell hideBelow="md" className="text-ink-secondary whitespace-nowrap">
                                    {TRIGGER_LABELS[run.trigger] ?? run.trigger}
                                </TableCell>
                                <TableCell hideBelow="lg" className="text-ink whitespace-nowrap">
                                    <span className="inline-flex items-center gap-1.5">
                                        <Package className="size-3.5 text-ink-faint" />
                                        {run.componentsScanned}
                                    </span>
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                    {run.vulnsFound > 0 ? (
                                        <div className="flex items-center">
                                            <VulnerabilitySquare count={run.counts.critical} severity="critical" />
                                            <VulnerabilitySquare count={run.counts.high} severity="high" />
                                            <VulnerabilitySquare count={run.counts.medium} severity="medium" />
                                            <VulnerabilitySquare count={run.counts.low} severity="low" />
                                        </div>
                                    ) : run.status === 'success' ? (
                                        <span className="inline-flex items-center gap-1 text-sm text-success">
                                            <ShieldCheck className="size-3.5" />
                                            None
                                        </span>
                                    ) : (
                                        <span className="text-sm text-ink-muted">—</span>
                                    )}
                                </TableCell>
                                <TableCell hideBelow="lg" className="text-ink-secondary whitespace-nowrap">
                                    {run.osvMirrorSyncedAt ? (
                                        <span title={`OSV data as of ${formatDate(run.osvMirrorSyncedAt)}`}>
                                            {formatRelativeTime(run.osvMirrorSyncedAt)}
                                        </span>
                                    ) : (
                                        <span className="text-ink-muted">—</span>
                                    )}
                                </TableCell>
                                <TableCell hideBelow="xl" className="text-ink-secondary whitespace-nowrap">
                                    {formatDuration(run.durationMs, 'precise')}
                                </TableCell>
                                <TableCell align="end" className="text-ink-muted whitespace-nowrap">
                                    <span
                                        className="inline-flex items-center gap-1.5"
                                        title={formatDate(run.createdAt)}
                                    >
                                        <Clock className="size-3.5 text-ink-faint" />
                                        {formatRelativeTime(run.createdAt)}
                                    </span>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    );
}
