'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Clock, Package } from 'lucide-react'
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
} from '@/components/ui'
import { formatDate, formatRelativeTime } from '@/utils/formatters'
import type { OsvSyncTabProps, ScanRunItem } from './types'

const TRIGGER_LABELS: Record<string, string> = {
    manual: 'Manual',
    sbom_upload: 'SBOM upload',
    schedule: 'Scheduled',
    system: 'System',
}

function StatusBadge({ status }: { status: ScanRunItem['status'] }) {
    if (status === 'success') {
        return (
            <span className="inline-flex items-center gap-1 text-sm text-success">
                <CheckCircle2 className="size-4" />
                Success
            </span>
        )
    }
    if (status === 'partial') {
        return (
            <span className="inline-flex items-center gap-1 text-sm text-attention">
                <AlertTriangle className="size-4" />
                Partial
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-1 text-sm text-danger">
            <XCircle className="size-4" />
            Failed
        </span>
    )
}

function formatDuration(ms: number | null): string {
    if (ms == null) return '—'
    if (ms < 1000) return `${ms}ms`
    const seconds = ms / 1000
    if (seconds < 60) return `${seconds.toFixed(1)}s`
    const minutes = Math.floor(seconds / 60)
    const rem = Math.round(seconds % 60)
    return `${minutes}m ${rem}s`
}

export function OsvSyncTab({ containerId }: OsvSyncTabProps) {
    const [runs, setRuns] = useState<ScanRunItem[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const fetchRuns = useCallback(async () => {
        setIsLoading(true)
        setError(null)
        try {
            const response = await fetch(`/api/containers/${containerId}/scan-history`)
            if (!response.ok) {
                throw new Error('Failed to fetch scan history')
            }
            const data = await response.json()
            setRuns(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to fetch scan history')
        } finally {
            setIsLoading(false)
        }
    }, [containerId])

    useEffect(() => {
        fetchRuns()
    }, [fetchRuns])

    if (isLoading) {
        return (
            <LoadingBlock label="Loading scan history..." />
        )
    }

    if (error) {
        return (
            <ErrorBlock
                title="Failed to load scan history"
                message={error}
                icon={<XCircle className="size-6 text-danger" />}
                onRetry={fetchRuns}
            />
        )
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
        )
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
                        {runs.map(run => (
                            <TableRow key={run.id} className="align-top">
                                <TableCell className="whitespace-nowrap">
                                    <StatusBadge status={run.status} />
                                    {run.errorMessage && (
                                        <p className="mt-1 max-w-40 truncate text-xs text-danger sm:max-w-xs" title={run.errorMessage}>
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
                                    {formatDuration(run.durationMs)}
                                </TableCell>
                                <TableCell align="end" className="text-ink-muted whitespace-nowrap">
                                    <span className="inline-flex items-center gap-1.5" title={formatDate(run.createdAt)}>
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
    )
}