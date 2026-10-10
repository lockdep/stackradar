'use client'

import { Database, Building2, Users, Package, Bug, Layers, Clock, FileWarning, Container, Server, Boxes, Ship, FolderTree } from 'lucide-react'
import { useTabData } from './useTabData'
import { TabShell, StatCard, PlanBadge, HealthTile } from './Shared'
import {
    formatNumber,
    formatLag,
    computeLagSeconds,
    thresholdTone,
    OSV_LAG_WARNING_SECONDS,
    OSV_LAG_CRITICAL_SECONDS,
    JOB_PENDING_WARNING_SECONDS,
    JOB_PENDING_CRITICAL_SECONDS,
} from './utils'
import type { OverviewData, QueueHealth } from './types'

/**
 * The three figures that say whether the worker is alive, in place of the
 * lifetime status grid that used to sit here.
 *
 * That grid counted every job ever created, so `completed` climbed forever and
 * set the scale for the other five boxes — a queue with one pending job stuck
 * for three hours rendered identically to a healthy one. None of these three
 * accumulate: each is a live measurement or a bounded window.
 */
function QueueHealthTiles({ health }: { health: QueueHealth }) {
    const { oldestPendingAgeSeconds: oldest, last24h, stuckAtMaxRetries } = health

    const settled = last24h.completed + last24h.failed
    const failureRate = settled > 0 ? (last24h.failed / settled) * 100 : null

    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <HealthTile
                label="Oldest pending job"
                // Null is not zero. Nothing pending is the healthy steady state;
                // "0s" would read as "a job just arrived", which is a different
                // and much less reassuring claim.
                value={oldest === null ? 'None waiting' : formatLag(oldest)}
                tone={oldest === null ? 'good' : thresholdTone(oldest, JOB_PENDING_WARNING_SECONDS, JOB_PENDING_CRITICAL_SECONDS)}
                detail={oldest === null
                    ? 'The queue is empty — the worker is keeping up'
                    : 'The worker polls every few seconds, so a long wait means it is not claiming'}
            />
            <HealthTile
                label="Failure rate · 24h"
                value={failureRate === null ? 'No jobs settled' : `${failureRate.toFixed(1)}%`}
                tone={thresholdTone(failureRate, 5, 25)}
                detail={failureRate === null
                    ? 'Nothing finished in the last 24 hours'
                    : `${formatNumber(last24h.failed)} failed of ${formatNumber(settled)} settled — cancellations excluded`}
            />
            <HealthTile
                label="Out of retries"
                value={stuckAtMaxRetries}
                tone={stuckAtMaxRetries > 0 ? 'warn' : 'good'}
                detail={stuckAtMaxRetries > 0
                    ? 'Failed with every retry spent — nothing moves these without a person'
                    : 'Every failed job still has a retry left'}
            />
        </div>
    )
}

export function OverviewTab({ refreshKey, onLoadingChange }: { refreshKey: number; onLoadingChange: (v: boolean) => void }) {
    const { data, isLoading, error, refetch } = useTabData<OverviewData>('/api/admin/overview', refreshKey, onLoadingChange)

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (() => {
                const { stats, osvState } = data
                const activeJobs = (stats.jobs.byStatus['pending'] ?? 0) + (stats.jobs.byStatus['processing'] ?? 0) + (stats.jobs.byStatus['scheduled'] ?? 0)


                // Not the applied watermark's age: that grows whenever OSV
                // publishes nothing, which is healthy. The gap between what OSV
                // has published and what we have applied is the real lag — see
                // the comment on AdminOsvStatus.state in admin.repository.ts.
                const lagSeconds = osvState
                    ? computeLagSeconds(osvState.lastModifiedSeen, osvState.lastModifiedApplied)
                    : null
                const lagTone = osvState?.initialized
                    ? thresholdTone(lagSeconds, OSV_LAG_WARNING_SECONDS, OSV_LAG_CRITICAL_SECONDS)
                    : 'bad'

                return (
                    <div className="space-y-6">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                            <StatCard icon={Building2} label="Organizations" value={stats.organizations.total} />
                            <StatCard icon={Users} label="Users" value={stats.users.total} />
                            <StatCard icon={Layers} label="SBOMs" value={stats.sboms.total} />
                            <StatCard icon={Package} label="Components" value={stats.components.total} sub={`${formatNumber(stats.components.withVulnerabilities)} with vulns`} />
                            <StatCard icon={Bug} label="Vulnerabilities in DB" value={stats.vulnerabilities.total} sub={`${formatNumber(stats.vulnerabilities.withdrawn)} withdrawn excluded`} />
                            <StatCard icon={FileWarning} label="Affected Package Entries" value={stats.vulnerabilities.affectedPackagesTotal} />
                            <StatCard icon={Clock} label="Active Jobs" value={activeJobs} sub={`${formatNumber(stats.jobs.total)} total`} />
                            {/* The lag, not the label. "Ready" was true of a mirror
                                twelve hours behind, which is the only state where this
                                tile had anything to say. */}
                            <StatCard
                                icon={Database}
                                label="OSV Mirror Lag"
                                value={
                                    !osvState ? 'Never synced'
                                        : !osvState.initialized ? 'Not init'
                                            : lagSeconds === null ? 'No watermark'
                                                : lagSeconds === 0 ? 'Up to date'
                                                    : `${formatLag(lagSeconds)} behind`
                                }
                                tone={lagTone}
                                sub={osvState
                                    ? `${osvState.syncStatus} · ${formatNumber(osvState.consecutiveFailures)} consecutive failures`
                                    : 'OSV sync has never run'}
                            />
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 mb-1">
                                <h2 className="text-sm font-semibold text-ink-secondary">Job Queue</h2>
                                <span className="text-xs text-ink-muted">
                                    {(['pending', 'scheduled', 'processing'] as const)
                                        .map((s) => `${formatNumber(stats.jobs.byStatus[s] ?? 0)} ${s}`)
                                        .join(' · ')}
                                </span>
                            </div>
                            <p className="text-xs text-ink-muted mb-4">
                                How the worker is doing now — the lifetime status counts it replaced could not say.
                            </p>
                            <QueueHealthTiles health={stats.jobs.health} />
                            {/* Kept, demoted. The lifetime totals are worth a glance and
                                worthless as the headline: `completed` only grows, so it
                                set the scale for every box beside it. */}
                            <p className="text-xs text-ink-muted mt-3 pt-3 border-t border-edge">
                                Lifetime:{' '}
                                {(['completed', 'failed', 'cancelled'] as const)
                                    .map((s) => `${formatNumber(stats.jobs.byStatus[s] ?? 0)} ${s}`)
                                    .join(' · ')}
                                {' · '}{formatNumber(stats.jobs.total)} total
                            </p>
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                                <h2 className="text-sm font-semibold text-ink-secondary">Images &amp; Kubernetes inventory</h2>
                                <span className="text-xs text-ink-muted">
                                    {formatNumber(stats.kubernetes.containers)} containers on {formatNumber(stats.images.total)} distinct images
                                </span>
                            </div>
                            {/* The ratio in that line is the argument for keying on the
                                digest, which is why the two figures sit together rather
                                than in the stat grid above. */}
                            <p className="text-xs text-ink-muted mb-4">
                                Counted across every tenant — `images` has no org column, so this is the only
                                view of it the platform has.
                            </p>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                                <StatCard
                                    icon={Container}
                                    label="Images"
                                    value={stats.images.total}
                                    sub={`${formatNumber(stats.images.withSbom)} with an SBOM`}
                                />
                                <StatCard
                                    icon={Layers}
                                    label="Awaiting SBOM"
                                    value={stats.images.awaitingSbom}
                                    tone={stats.images.awaitingSbom > 0 ? 'warn' : 'good'}
                                    sub={stats.images.awaitingSbom > 0 ? 'Running, never scanned' : 'Every running image has one'}
                                />
                                <StatCard
                                    icon={Database}
                                    label="Orphaned"
                                    value={stats.images.orphaned}
                                    sub="Referenced by nothing — GC candidates"
                                />
                                <StatCard icon={Server} label="Clusters" value={stats.kubernetes.clusters} />
                                <StatCard icon={FolderTree} label="Namespaces" value={stats.kubernetes.namespaces} />
                                <StatCard icon={Boxes} label="Workloads" value={stats.kubernetes.workloads} />
                                <StatCard icon={Container} label="Containers" value={stats.kubernetes.containers} />
                                <StatCard icon={Ship} label="Helm releases" value={stats.kubernetes.helmReleases} />
                            </div>
                        </div>

                        <div className="bg-surface-raised rounded-md border border-edge p-5">
                            <h2 className="text-sm font-semibold text-ink-secondary mb-4">Organizations by Plan</h2>
                            <div className="space-y-2">
                                {(['free', 'pro'] as const).map((plan) => {
                                    const n = stats.organizations.byPlan[plan] ?? 0
                                    const pct = stats.organizations.total > 0 ? (n / stats.organizations.total) * 100 : 0
                                    return (
                                        <div key={plan} className="flex items-center gap-3">
                                            <PlanBadge plan={plan} />
                                            <div className="flex-1 h-1.5 bg-track rounded-full overflow-hidden">
                                                <div className="h-full bg-accent-emphasis rounded-full" style={{ width: `${pct}%` }} />
                                            </div>
                                            <span className="text-sm font-medium text-ink-secondary w-8 text-right">{n}</span>
                                        </div>
                                    )
                                })}
                            </div>
                        </div>
                    </div>
                )
            })()}
        </TabShell>
    )
}
