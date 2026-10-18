'use client';

import Link from 'next/link';
import {
    Database,
    Building2,
    Users,
    Package,
    Bug,
    Layers,
    FileWarning,
    Container,
    Server,
    Boxes,
    Ship,
    FolderTree,
} from 'lucide-react';
import { useTabData } from './useTabData';
import { useRuntimeConfig } from '@/components/providers';
import { getScannerHealth, ScannerDot, type ScannerHealth } from '@/components/clusters/ScannerDot';
import { isScannerOutdated } from '@/components/clusters/scannerInstall';
import { TabShell, StatCard, PlanBadge, HealthTile } from './Shared';
import {
    formatNumber,
    formatLag,
    formatTimeAgo,
    computeLagSeconds,
    thresholdTone,
    type HealthTone,
    OSV_LAG_WARNING_SECONDS,
    OSV_LAG_CRITICAL_SECONDS,
    JOB_PENDING_WARNING_SECONDS,
    JOB_PENDING_CRITICAL_SECONDS,
    INVENTORY_STALE_WARNING_SECONDS,
    INVENTORY_STALE_CRITICAL_SECONDS,
} from './utils';
import type { MirrorStatus } from '@/lib/mirror-status';
import type { OverviewData, QueueHealth, PipelineHealth, OsvSyncState } from './types';

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
    const { oldestPendingAgeSeconds: oldest, last24h, stuckAtMaxRetries } = health;

    const settled = last24h.completed + last24h.failed;
    const failureRate = settled > 0 ? (last24h.failed / settled) * 100 : null;

    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <HealthTile
                label="Oldest pending job"
                // Null is not zero. Nothing pending is the healthy steady state;
                // "0s" would read as "a job just arrived", which is a different
                // and much less reassuring claim.
                value={oldest === null ? 'None waiting' : formatLag(oldest)}
                tone={oldestPendingTone(oldest)}
                detail={
                    oldest === null
                        ? 'The queue is empty — the worker is keeping up'
                        : 'The worker polls every few seconds, so a long wait means it is not claiming'
                }
            />
            <HealthTile
                label="Failure rate · 24h"
                value={failureRate === null ? 'No jobs settled' : `${failureRate.toFixed(1)}%`}
                tone={thresholdTone(failureRate, 5, 25)}
                detail={
                    failureRate === null
                        ? 'Nothing finished in the last 24 hours'
                        : `${formatNumber(last24h.failed)} failed of ${formatNumber(settled)} settled — cancellations excluded`
                }
            />
            <HealthTile
                label="Out of retries"
                value={stuckAtMaxRetries}
                tone={stuckAtMaxRetries > 0 ? 'warn' : 'good'}
                detail={
                    stuckAtMaxRetries > 0
                        ? 'Failed with every retry spent — nothing moves these without a person'
                        : 'Every failed job still has a retry left'
                }
            />
        </div>
    );
}

function oldestPendingTone(oldest: number | null): HealthTone {
    return oldest === null ? 'good' : thresholdTone(oldest, JOB_PENDING_WARNING_SECONDS, JOB_PENDING_CRITICAL_SECONDS);
}

// ── The pipeline ─────────────────────────────────────────────────────────────
//
// One tile per stage, left to right in the order data flows: the scanner
// reports, the inventory lands, SBOMs arrive, the queue matches them against
// the mirror, which EPSS and KEV score. Each tile's tone is the stage's own
// verdict and its sentence says what the figure means at that value, so a
// stopped scanner, a stuck queue and a stale feed are each one glance.

const worst = (...tones: HealthTone[]): HealthTone => {
    const rank: Record<HealthTone, number> = { neutral: 0, good: 1, warn: 2, bad: 3 };
    return tones.reduce((a, b) => (rank[b] > rank[a] ? b : a), 'neutral');
};

const SCANNER_TONE: Record<ScannerHealth, HealthTone> = {
    active: 'good',
    waiting: 'neutral',
    stale: 'warn',
    offline: 'bad',
};

const SCANNER_WORD: Record<ScannerHealth, string> = {
    active: 'Reporting',
    waiting: 'Waiting',
    stale: 'Stale',
    offline: 'Offline',
};

function ScannerStage({
    scanner,
    multiCluster,
    chartVersion,
}: {
    scanner: PipelineHealth['scanner'];
    multiCluster: boolean;
    chartVersion: string | null;
}) {
    const rows = scanner.clusters.map((c) => ({
        ...c,
        health: getScannerHealth(c.scannerLastSeenAt),
        // Two different "old": behind the chart the install advertises (a
        // nudge) and below what the server still accepts (a break coming).
        outdated: isScannerOutdated(c.scannerVersion, chartVersion),
        belowMin: isScannerOutdated(c.scannerVersion, scanner.minVersion),
    }));

    if (rows.length === 0) {
        return (
            <HealthTile
                label="Scanner"
                value="No cluster"
                tone="neutral"
                detail={
                    multiCluster
                        ? 'No tenant has connected a cluster yet'
                        : 'The install has no cluster — set BOOTSTRAP_CLUSTER_ID and the scanner key'
                }
            />
        );
    }

    if (!multiCluster) {
        // One cluster: the tile is that cluster.
        const c = rows[0]!;
        const problems: string[] = [];
        if (c.belowMin) problems.push(`below the minimum ${scanner.minVersion} the server supports`);
        else if (c.outdated) problems.push(`chart ${chartVersion} is available`);
        if (c.ownerMetadataCollected === false) problems.push('the agent could not read controllers');
        const tone = worst(
            SCANNER_TONE[c.health],
            c.belowMin ? 'bad' : c.outdated ? 'warn' : 'neutral',
            c.ownerMetadataCollected === false ? 'warn' : 'neutral',
        );
        const detail =
            c.health === 'waiting'
                ? 'The scanner has never checked in — the install snippet is on the cluster page'
                : `Last seen ${formatTimeAgo(c.scannerLastSeenAt)}${c.scannerVersion ? ` · scanner ${c.scannerVersion}` : ''}${c.kubernetesVersion ? ` · Kubernetes ${c.kubernetesVersion}` : ''}`;
        return (
            <HealthTile label="Scanner" value={SCANNER_WORD[c.health]} tone={tone} detail={detail}>
                <p className="text-xs mt-2 flex items-center gap-2">
                    <ScannerDot health={c.health} />
                    <Link href={`/clusters/${c.id}`} className="text-accent hover:underline truncate">
                        {c.name}
                    </Link>
                </p>
                {problems.length > 0 && <p className="text-xs text-ink-secondary mt-1">{problems.join(' · ')}</p>}
            </HealthTile>
        );
    }

    // Many clusters: counts by health, the two "old" counts, and the link.
    const by: Record<ScannerHealth, number> = { active: 0, stale: 0, offline: 0, waiting: 0 };
    for (const r of rows) by[r.health] += 1;
    const belowMin = rows.filter((r) => r.belowMin).length;
    const outdated = rows.filter((r) => r.outdated && !r.belowMin).length;
    const noOwners = rows.filter((r) => r.ownerMetadataCollected === false).length;
    const tone = worst(
        by.offline > 0 ? 'bad' : 'neutral',
        by.stale > 0 || outdated > 0 || noOwners > 0 ? 'warn' : 'neutral',
        belowMin > 0 ? 'bad' : 'neutral',
        by.active > 0 ? 'good' : 'neutral',
    );
    const parts = [
        by.offline > 0 && `${by.offline} offline`,
        by.stale > 0 && `${by.stale} stale`,
        by.waiting > 0 && `${by.waiting} never seen`,
        belowMin > 0 && `${belowMin} below the minimum version`,
        outdated > 0 && `${outdated} behind chart ${chartVersion}`,
        noOwners > 0 && `${noOwners} could not read controllers`,
    ].filter((p): p is string => Boolean(p));
    return (
        <HealthTile
            label="Scanners"
            value={`${formatNumber(by.active)} of ${formatNumber(scanner.total)} reporting`}
            tone={tone}
            detail={parts.length > 0 ? parts.join(' · ') : 'Every cluster has reported within five minutes'}
        >
            <p className="text-xs mt-2">
                <Link href="/clusters" className="text-accent hover:underline">
                    All clusters
                </Link>
                {scanner.total > scanner.clusters.length && (
                    <span className="text-ink-muted"> · counted over the first {scanner.clusters.length}</span>
                )}
            </p>
        </HealthTile>
    );
}

function ageSeconds(iso: string | null): number | null {
    return iso === null ? null : Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
}

function InventoryStage({ inventory }: { inventory: PipelineHealth['inventory'] }) {
    const age = ageSeconds(inventory.newestSeenAt);
    return (
        <HealthTile
            label="Inventory"
            value={age === null ? 'None yet' : `${formatLag(age)} ago`}
            tone={
                age === null
                    ? 'neutral'
                    : thresholdTone(age, INVENTORY_STALE_WARNING_SECONDS, INVENTORY_STALE_CRITICAL_SECONDS)
            }
            detail={
                age === null
                    ? 'No inventory report has landed — the Dashboard shows nothing until one does'
                    : age < INVENTORY_STALE_WARNING_SECONDS
                      ? 'The newest container sighting; the agent re-lists everything every six hours'
                      : 'Nothing has reported a container in longer than the agent’s sweep — is it running?'
            }
        />
    );
}

function SbomStage({ sboms, awaiting }: { sboms: PipelineHealth['sboms']; awaiting: number }) {
    const age = ageSeconds(sboms.newestCreatedAt);
    return (
        <HealthTile
            label="SBOMs"
            value={awaiting > 0 ? `${formatNumber(awaiting)} awaiting` : age === null ? 'None yet' : 'All scanned'}
            tone={awaiting > 0 ? 'warn' : age === null ? 'neutral' : 'good'}
            detail={
                age === null
                    ? 'No SBOM has been uploaded yet'
                    : awaiting > 0
                      ? `Running images with no SBOM · newest upload ${formatLag(age)} ago`
                      : `Every running image has one · newest upload ${formatLag(age)} ago`
            }
        />
    );
}

function QueueStage({ health }: { health: QueueHealth }) {
    const { oldestPendingAgeSeconds: oldest, stuckAtMaxRetries } = health;
    const tone = worst(oldestPendingTone(oldest), stuckAtMaxRetries > 0 ? 'warn' : 'good');
    return (
        <HealthTile
            label="Queue"
            value={oldest === null ? 'Idle' : `${formatLag(oldest)} waiting`}
            tone={tone}
            detail={
                stuckAtMaxRetries > 0
                    ? `${formatNumber(stuckAtMaxRetries)} out of retries · the Jobs tab has them`
                    : oldest === null
                      ? 'Nothing pending — the worker is keeping up'
                      : 'The oldest pending job; past fifteen minutes the worker is not claiming'
            }
        />
    );
}

function MirrorStage({ osvState, mirror }: { osvState: OsvSyncState | null; mirror: MirrorStatus }) {
    // Before the first generation is live, the stage is the bootstrap: the
    // same status the app shell's banner reads, so the two never disagree
    // about whether the database is still being built.
    if (!osvState?.initialized) {
        const b = mirror.osv.bootstrap;
        const value =
            mirror.osv.status === 'running'
                ? b && b.archiveCount > 1
                    ? `Building · ${b.archiveIndex} of ${b.archiveCount}`
                    : 'Building'
                : mirror.osv.status === 'failed'
                  ? 'Build failed'
                  : 'Not built';
        return (
            <HealthTile
                label="OSV mirror"
                value={value}
                tone={mirror.osv.status === 'failed' ? 'bad' : mirror.osv.status === 'running' ? 'neutral' : 'warn'}
                detail={
                    mirror.osv.status === 'failed'
                        ? `${mirror.osv.lastError ?? 'unknown error'} — the scheduler retries`
                        : mirror.osv.status === 'running'
                          ? `${b?.phase ?? 'starting'}${b?.ecosystem ? ` ${b.ecosystem}` : ''} · images show no findings until it finishes`
                          : 'The first import has not started; the scheduler begins it at start-up'
                }
            />
        );
    }

    // Not the applied watermark's age: that grows whenever OSV publishes
    // nothing, which is healthy. The gap between what OSV has published and
    // what we have applied is the real lag — see the comment on
    // AdminOsvStatus.state in admin.repository.ts.
    const lagSeconds = computeLagSeconds(osvState.lastModifiedSeen, osvState.lastModifiedApplied);
    const tone = worst(
        thresholdTone(lagSeconds, OSV_LAG_WARNING_SECONDS, OSV_LAG_CRITICAL_SECONDS),
        osvState.consecutiveFailures > 0 ? 'warn' : 'neutral',
    );
    return (
        <HealthTile
            label="OSV mirror"
            value={
                lagSeconds === null
                    ? 'No watermark'
                    : lagSeconds === 0
                      ? 'Up to date'
                      : `${formatLag(lagSeconds)} behind`
            }
            tone={tone}
            detail={
                osvState.consecutiveFailures > 0
                    ? `${formatNumber(osvState.consecutiveFailures)} consecutive failures · ${osvState.lastError ?? osvState.syncStatus}`
                    : `${osvState.syncStatus} · last poll ${formatTimeAgo(osvState.lastSuccessfulPollAt)}`
            }
        />
    );
}

function FeedStage({
    label,
    feed,
    mirrorReady,
    staleAfterHours,
}: {
    label: string;
    feed: { state: { lastSyncedAt: string | null; lastError: string | null } | null; stale: boolean };
    mirrorReady: boolean;
    staleAfterHours: number;
}) {
    const synced = feed.state?.lastSyncedAt ?? null;
    if (synced === null) {
        return (
            <HealthTile
                label={label}
                value="Not loaded"
                tone={feed.state?.lastError ? 'bad' : mirrorReady ? 'warn' : 'neutral'}
                detail={
                    feed.state?.lastError
                        ? `${feed.state.lastError} — retried daily`
                        : mirrorReady
                          ? 'Runs once after the mirror is built, then daily'
                          : 'Runs after the OSV import'
                }
            />
        );
    }
    return (
        <HealthTile
            label={label}
            value={feed.stale ? 'Stale' : 'Fresh'}
            tone={feed.stale ? 'warn' : feed.state?.lastError ? 'warn' : 'good'}
            detail={
                feed.stale
                    ? `Last loaded ${formatTimeAgo(synced)} — older than ${staleAfterHours} hours`
                    : feed.state?.lastError
                      ? `Last run failed; data from ${formatTimeAgo(synced)} is still live`
                      : `Loaded ${formatTimeAgo(synced)}`
            }
        />
    );
}

function Pipeline({
    data,
    multiCluster,
    chartVersion,
}: {
    data: OverviewData;
    multiCluster: boolean;
    chartVersion: string | null;
}) {
    const { stats, osvState, pipeline, feeds, mirror } = data;
    const mirrorReady = mirror.osv.status === 'ready';
    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-3">
            <ScannerStage scanner={pipeline.scanner} multiCluster={multiCluster} chartVersion={chartVersion} />
            <InventoryStage inventory={pipeline.inventory} />
            <SbomStage sboms={pipeline.sboms} awaiting={stats.images.awaitingSbom} />
            <QueueStage health={stats.jobs.health} />
            <MirrorStage osvState={osvState} mirror={mirror} />
            <FeedStage
                label="EPSS"
                feed={feeds.epss}
                mirrorReady={mirrorReady}
                staleAfterHours={feeds.staleAfterHours}
            />
            <FeedStage label="KEV" feed={feeds.kev} mirrorReady={mirrorReady} staleAfterHours={feeds.staleAfterHours} />
        </div>
    );
}

export function OverviewTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<OverviewData>(
        '/api/admin/overview',
        refreshKey,
        onLoadingChange,
    );
    // The tenant figures — how many orgs, on which plans — are the cloud
    // operator's. A single-org install has one, and it is the install.
    const { edition, scannerChartVersion } = useRuntimeConfig();
    const { multiOrg, multiCluster } = edition;

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data &&
                (() => {
                    const { stats } = data;
                    const plans = Object.keys(stats.organizations.byPlan).sort();

                    return (
                        <div className="space-y-6">
                            <div>
                                <h2 className="text-sm font-semibold text-ink-secondary mb-1">Pipeline</h2>
                                <p className="text-xs text-ink-muted mb-3">
                                    Scanner to score, left to right. A tile is red only when something is wrong right
                                    now.
                                </p>
                                <Pipeline data={data} multiCluster={multiCluster} chartVersion={scannerChartVersion} />
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
                                    {' · '}
                                    {formatNumber(stats.jobs.total)} total
                                </p>
                            </div>

                            <div className="bg-surface-raised rounded-md border border-edge p-5">
                                <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                                    <h2 className="text-sm font-semibold text-ink-secondary">
                                        Images &amp; Kubernetes inventory
                                    </h2>
                                    <span className="text-xs text-ink-muted">
                                        {formatNumber(stats.kubernetes.containers)} containers on{' '}
                                        {formatNumber(stats.images.total)} distinct images
                                    </span>
                                </div>
                                {/* The ratio in that line is the argument for keying on the
                                digest, which is why the two figures sit together rather
                                than in the stat grid above. */}
                                <p className="text-xs text-ink-muted mb-4">
                                    {multiOrg
                                        ? 'Counted across every cluster of every tenant. An image belongs to one cluster, so a digest running in two clusters is two images.'
                                        : 'An image is a digest as this cluster sees it, so each digest is counted once however many places it runs.'}
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
                                        sub={
                                            stats.images.awaitingSbom > 0
                                                ? 'Running, never scanned'
                                                : 'Every running image has one'
                                        }
                                    />
                                    <StatCard
                                        icon={Database}
                                        label="Orphaned"
                                        value={stats.images.orphaned}
                                        sub="Referenced by nothing — GC candidates"
                                    />
                                    <StatCard icon={Server} label="Clusters" value={stats.kubernetes.clusters} />
                                    <StatCard
                                        icon={FolderTree}
                                        label="Namespaces"
                                        value={stats.kubernetes.namespaces}
                                    />
                                    <StatCard icon={Boxes} label="Workloads" value={stats.kubernetes.workloads} />
                                    <StatCard icon={Container} label="Containers" value={stats.kubernetes.containers} />
                                    <StatCard icon={Ship} label="Helm releases" value={stats.kubernetes.helmReleases} />
                                </div>
                            </div>

                            <div className="bg-surface-raised rounded-md border border-edge p-5">
                                <h2 className="text-sm font-semibold text-ink-secondary mb-1">
                                    Advisories &amp; SBOMs
                                </h2>
                                <p className="text-xs text-ink-muted mb-4">
                                    What the matcher works with: the mirror on one side, the uploaded documents on the
                                    other.
                                </p>
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                                    <StatCard
                                        icon={Bug}
                                        label="Vulnerabilities in DB"
                                        value={stats.vulnerabilities.total}
                                        sub={`${formatNumber(stats.vulnerabilities.withdrawn)} withdrawn excluded`}
                                    />
                                    <StatCard
                                        icon={FileWarning}
                                        label="Affected Package Entries"
                                        value={stats.vulnerabilities.affectedPackagesTotal}
                                    />
                                    <StatCard icon={Layers} label="SBOMs" value={stats.sboms.total} />
                                    <StatCard
                                        icon={Package}
                                        label="Components"
                                        value={stats.components.total}
                                        sub={`${formatNumber(stats.components.withVulnerabilities)} with vulns`}
                                    />
                                </div>
                            </div>

                            <div className="bg-surface-raised rounded-md border border-edge p-5">
                                <h2 className="text-sm font-semibold text-ink-secondary mb-4">
                                    {multiOrg ? 'Tenants' : 'Accounts'}
                                </h2>
                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
                                    {multiOrg && (
                                        <StatCard
                                            icon={Building2}
                                            label="Organizations"
                                            value={stats.organizations.total}
                                        />
                                    )}
                                    <StatCard icon={Users} label="Users" value={stats.users.total} />
                                </div>
                                {/* Every plan the table holds, not a fixed list: a fixed one
                                    drew two empty bars in the community edition and could
                                    not show a tier it did not name. */}
                                {multiOrg && (
                                    <>
                                        <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
                                            By plan
                                        </h3>
                                        {plans.length === 0 ? (
                                            <p className="text-sm text-ink-muted">No organizations yet.</p>
                                        ) : (
                                            <div className="space-y-2">
                                                {plans.map((plan) => {
                                                    const n = stats.organizations.byPlan[plan] ?? 0;
                                                    const pct =
                                                        stats.organizations.total > 0
                                                            ? (n / stats.organizations.total) * 100
                                                            : 0;
                                                    return (
                                                        <div key={plan} className="flex items-center gap-3">
                                                            <PlanBadge plan={plan} />
                                                            <div className="flex-1 h-1.5 bg-track rounded-full overflow-hidden">
                                                                <div
                                                                    className="h-full bg-accent-emphasis rounded-full"
                                                                    style={{ width: `${pct}%` }}
                                                                />
                                                            </div>
                                                            <span className="text-sm font-medium text-ink-secondary w-8 text-right">
                                                                {n}
                                                            </span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>
                    );
                })()}
        </TabShell>
    );
}
