'use client';

import { useState } from 'react';
import {
    CheckCircle,
    Clock,
    XCircle,
    Loader,
    User,
    Upload,
    CalendarClock,
    Cog,
    ChevronLeft,
    ChevronRight,
} from 'lucide-react';
import {
    Badge,
    Spinner,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui';
import { useTabData } from './useTabData';
import { useRuntimeConfig } from '@/components/providers';
import { TabShell } from './Shared';
import { formatTimeAgo, formatDuration } from './utils';
import type { AdminJob, AdminJobsData, JobStatus, JobTrigger } from './types';

const STATUS_CONFIG: Record<
    JobStatus,
    { icon: typeof Clock; label: string; variant: 'attention' | 'accent' | 'success' | 'danger' | 'neutral' }
> = {
    pending: { icon: Clock, label: 'Pending', variant: 'attention' },
    scheduled: { icon: Clock, label: 'Scheduled', variant: 'accent' },
    processing: { icon: Loader, label: 'Processing', variant: 'accent' },
    completed: { icon: CheckCircle, label: 'Completed', variant: 'success' },
    failed: { icon: XCircle, label: 'Failed', variant: 'danger' },
    cancelled: { icon: XCircle, label: 'Cancelled', variant: 'neutral' },
};

const TYPE_LABELS: Record<string, string> = {
    vulnerability_scan: 'Vuln Scan',
    sbom_process: 'SBOM Process',
    full_sync: 'Full Sync',
    scheduled_scan: 'Scheduled Scan',
    chart_render: 'Chart Render',
    platform_scan: 'Platform Scan',
    chart_repo_refresh: 'Chart Repo Refresh',
};

const TRIGGER_CONFIG: Record<JobTrigger, { icon: typeof Clock; label: string }> = {
    manual: { icon: User, label: 'Manual' },
    sbom_upload: { icon: Upload, label: 'SBOM Upload' },
    schedule: { icon: CalendarClock, label: 'Scheduled' },
    system: { icon: Cog, label: 'System' },
};

import { PAGE_SIZE } from '@/lib/constants';

const ALL_STATUSES: JobStatus[] = ['pending', 'scheduled', 'processing', 'completed', 'failed', 'cancelled'];

/** How long a job has run — to now while it is still running, so it ticks on each render. */
function jobDuration(startedAt: string | null, completedAt: string | null): string {
    if (!startedAt) return '—';
    const end = completedAt ? new Date(completedAt) : new Date();
    return formatDuration(end.getTime() - new Date(startedAt).getTime());
}

function JobStatusBadge({ status }: { status: JobStatus }) {
    const config = STATUS_CONFIG[status];
    const Icon = config.icon;
    return (
        <Badge variant={config.variant}>
            <Icon className={`size-3 mr-1.5 ${status === 'processing' ? 'animate-spin' : ''}`} />
            {config.label}
        </Badge>
    );
}

function JobDetail({ job, multiOrg, onClose }: { job: AdminJob; multiOrg: boolean; onClose: () => void }) {
    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink break-words">{job.title}</h3>
                    <p className="text-xs text-ink-muted mt-0.5 font-mono break-all">{job.id}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-xs text-ink-muted hover:text-ink-secondary cursor-pointer shrink-0"
                >
                    Close
                </button>
            </div>

            <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Status</p>
                    <JobStatusBadge status={job.status} />
                </div>
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Type</p>
                    <p className="text-ink-secondary">{TYPE_LABELS[job.type] ?? job.type}</p>
                </div>
                {multiOrg && (
                    <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">
                            Organization
                        </p>
                        <p className="text-ink-secondary">
                            {job.orgName} <span className="text-ink-muted">({job.orgSlug})</span>
                        </p>
                    </div>
                )}
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Triggered By</p>
                    {(() => {
                        const t = TRIGGER_CONFIG[job.triggeredBy] ?? TRIGGER_CONFIG.manual;
                        const Icon = t.icon;
                        return (
                            <span className="inline-flex items-center gap-1.5 text-ink-secondary">
                                <Icon className="size-3.5 text-ink-faint" />
                                {t.label}
                            </span>
                        );
                    })()}
                </div>
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Duration</p>
                    <p className="text-ink-secondary tabular-nums">{jobDuration(job.startedAt, job.completedAt)}</p>
                </div>
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Priority</p>
                    <p className="text-ink-secondary">{job.priority}</p>
                </div>
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Retries</p>
                    <p className="text-ink-secondary">
                        {job.retryCount} / {job.maxRetries}
                    </p>
                </div>
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Progress</p>
                    <p className="text-ink-secondary">{job.progress}%</p>
                </div>
                {job.imageId && (
                    <div className="col-span-2">
                        <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Image ID</p>
                        <p className="text-ink-secondary font-mono text-xs break-all">{job.imageId}</p>
                    </div>
                )}
                {job.scheduledFor && (
                    <div className="col-span-2">
                        <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">
                            Scheduled For
                        </p>
                        <p className="text-ink-secondary">{new Date(job.scheduledFor).toLocaleString()}</p>
                    </div>
                )}
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Created</p>
                    <p className="text-ink-secondary">{new Date(job.createdAt).toLocaleString()}</p>
                </div>
                {job.startedAt && (
                    <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Started</p>
                        <p className="text-ink-secondary">{new Date(job.startedAt).toLocaleString()}</p>
                    </div>
                )}
                {job.completedAt && (
                    <div>
                        <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">Completed</p>
                        <p className="text-ink-secondary">{new Date(job.completedAt).toLocaleString()}</p>
                    </div>
                )}
            </div>

            {job.progressMessage && (
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-1">Progress Message</p>
                    <p className="text-sm text-accent bg-accent-subtle rounded-sm px-3 py-2">{job.progressMessage}</p>
                </div>
            )}

            {job.errorMessage && (
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-1">Error</p>
                    {job.errorCode && <p className="text-xs font-mono text-danger mb-1">{job.errorCode}</p>}
                    <p className="text-sm text-danger bg-danger-subtle rounded-sm px-3 py-2 whitespace-pre-wrap break-words">
                        {job.errorMessage}
                    </p>
                </div>
            )}
        </div>
    );
}

export function JobsTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const [offset, setOffset] = useState(0);
    const [statusFilter, setStatusFilter] = useState<JobStatus | ''>('');
    const [selectedJob, setSelectedJob] = useState<AdminJob | null>(null);
    // Which tenant a job belongs to is a column only where there is more
    // than one tenant to tell apart.
    const { multiOrg } = useRuntimeConfig().edition;

    const statusQs = statusFilter ? `&status=${statusFilter}` : '';
    const url = `/api/admin/jobs?limit=${PAGE_SIZE}&offset=${offset}${statusQs}`;

    const { data, isLoading, error, refetch } = useTabData<AdminJobsData>(url, refreshKey, onLoadingChange);

    const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;
    const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

    function handleStatusChange(s: JobStatus | '') {
        setStatusFilter(s);
        setOffset(0);
        setSelectedJob(null);
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
                <span className="text-xs text-ink-muted font-medium">Filter by status:</span>
                <button
                    type="button"
                    onClick={() => handleStatusChange('')}
                    className={`text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${statusFilter === '' ? 'bg-ink text-surface border-ink' : 'border-edge text-ink-secondary hover:border-edge-strong'}`}
                >
                    All
                </button>
                {ALL_STATUSES.map((s) => {
                    const cfg = STATUS_CONFIG[s];
                    return (
                        <button
                            key={s}
                            type="button"
                            onClick={() => handleStatusChange(s)}
                            className={`text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${statusFilter === s ? 'bg-ink text-surface border-ink' : 'border-edge text-ink-secondary hover:border-edge-strong'}`}
                        >
                            {cfg.label}
                        </button>
                    );
                })}
            </div>

            {selectedJob && <JobDetail job={selectedJob} multiOrg={multiOrg} onClose={() => setSelectedJob(null)} />}

            <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
                {data && (
                    <>
                        <TableContainer>
                            {data.jobs.length === 0 ? (
                                <div className="py-12 text-center">
                                    <Clock className="mx-auto size-8 text-ink-faint/70" />
                                    <p className="mt-3 text-sm text-ink-muted">No jobs found</p>
                                </div>
                            ) : (
                                <Table density="spacious" aria-label="Jobs">
                                    <TableHead>
                                        <TableHeader>Title</TableHeader>
                                        {multiOrg && <TableHeader hideBelow="xl">Org</TableHeader>}
                                        <TableHeader hideBelow="md">Type</TableHeader>
                                        <TableHeader>Status</TableHeader>
                                        <TableHeader hideBelow="xl">Trigger</TableHeader>
                                        <TableHeader hideBelow="sm">Duration</TableHeader>
                                        <TableHeader align="end" hideBelow="sm">
                                            Created
                                        </TableHeader>
                                    </TableHead>
                                    <TableBody>
                                        {data.jobs.map((job) => {
                                            const trigger = TRIGGER_CONFIG[job.triggeredBy] ?? TRIGGER_CONFIG.manual;
                                            const TriggerIcon = trigger.icon;
                                            const isSelected = selectedJob?.id === job.id;
                                            return (
                                                <TableRow
                                                    key={job.id}
                                                    onClick={() => setSelectedJob(isSelected ? null : job)}
                                                    selected={isSelected}
                                                >
                                                    <TableCell>
                                                        <button
                                                            type="button"
                                                            aria-expanded={isSelected}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                setSelectedJob(isSelected ? null : job);
                                                            }}
                                                            className="text-xs sm:text-sm text-ink truncate max-w-48 sm:max-w-xs text-left cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                                        >
                                                            {job.title}
                                                        </button>
                                                        {job.status === 'failed' && job.errorMessage && (
                                                            <p className="mt-0.5 text-xs text-danger truncate max-w-48 sm:max-w-xs">
                                                                {job.errorMessage}
                                                            </p>
                                                        )}
                                                        {job.status === 'processing' && job.progressMessage && (
                                                            <p className="mt-0.5 text-xs text-accent truncate max-w-48 sm:max-w-xs">
                                                                {job.progressMessage}
                                                            </p>
                                                        )}
                                                    </TableCell>
                                                    {multiOrg && (
                                                        <TableCell hideBelow="xl">
                                                            <p className="text-sm text-ink-secondary truncate max-w-[120px]">
                                                                {job.orgName}
                                                            </p>
                                                        </TableCell>
                                                    )}
                                                    <TableCell
                                                        hideBelow="md"
                                                        className="text-ink-secondary whitespace-nowrap"
                                                    >
                                                        {TYPE_LABELS[job.type] ?? job.type}
                                                    </TableCell>
                                                    <TableCell className="whitespace-nowrap">
                                                        <JobStatusBadge status={job.status} />
                                                    </TableCell>
                                                    <TableCell hideBelow="xl" className="whitespace-nowrap">
                                                        <span className="inline-flex items-center text-sm text-ink-secondary">
                                                            <TriggerIcon className="size-3.5 mr-1.5 text-ink-faint" />
                                                            {trigger.label}
                                                        </span>
                                                    </TableCell>
                                                    <TableCell
                                                        hideBelow="sm"
                                                        className="text-ink-muted tabular-nums whitespace-nowrap"
                                                    >
                                                        {jobDuration(job.startedAt, job.completedAt)}
                                                    </TableCell>
                                                    <TableCell
                                                        align="end"
                                                        hideBelow="sm"
                                                        className="text-ink-muted whitespace-nowrap"
                                                    >
                                                        {formatTimeAgo(job.createdAt)}
                                                    </TableCell>
                                                </TableRow>
                                            );
                                        })}
                                    </TableBody>
                                </Table>
                            )}
                        </TableContainer>

                        {totalPages > 1 && (
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-ink-muted">
                                <span>{data.total} jobs total</span>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                        disabled={offset === 0}
                                        className="p-1.5 rounded-sm hover:bg-surface-hover disabled:opacity-40 cursor-pointer disabled:cursor-default"
                                    >
                                        <ChevronLeft className="size-4" />
                                    </button>
                                    <span className="tabular-nums">
                                        Page {currentPage} of {totalPages}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setOffset(offset + PAGE_SIZE)}
                                        disabled={offset + PAGE_SIZE >= data.total}
                                        className="p-1.5 rounded-sm hover:bg-surface-hover disabled:opacity-40 cursor-pointer disabled:cursor-default"
                                    >
                                        <ChevronRight className="size-4" />
                                    </button>
                                </div>
                            </div>
                        )}
                    </>
                )}
            </TabShell>

            {isLoading && (
                <div className="flex justify-center py-4">
                    <Spinner size="sm" className="text-ink-faint/70" />
                </div>
            )}
        </div>
    );
}
