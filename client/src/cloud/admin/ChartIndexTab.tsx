// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { useState } from 'react';
import {
    CheckCircle,
    XCircle,
    Loader,
    Clock,
    Package,
    Layers,
    Boxes,
    Database,
    FileWarning,
    Ship,
    Radar,
    TrendingUp,
    HardDrive,
} from 'lucide-react';
import { Badge, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@/components/ui';
import { useNow } from '@/hooks';
import { useTabData } from '@/views/admin/useTabData';
import { TabShell, StatCard, HealthTile, DistributionBar } from '@/views/admin/Shared';
import { formatTimeAgo, formatNumber, formatLag, thresholdTone, type HealthTone } from '@/views/admin/utils';
import type { ChartIndexRun, ChartIndexStatus, ChartIndexTask, ChartIndexTaskStatus } from './types';

/**
 * The public chart index (charts.stackradar.io) as its operator sees it:
 * the pipeline's tasks and their last runs, the catalogue and how much of
 * it rendered, the image inventory and its queue, the score side, and the
 * database. Everything comes from one call to `/api/admin/chart-index`,
 * which relays the charts site's `GET /internal/status` — the client
 * never touches that database, and the numbers are the site's own.
 *
 * The tab reads top-down from "is it alive" to "what is it made of": the
 * health tiles, then the task table, then the sections that explain a
 * tile that turned amber.
 */

/**
 * The score task runs daily at 07:00 UTC; a scored-at older than a day
 * and a bit means the daily schedule was skipped or failed, two days
 * means the public pages are about to carry the stale banner (the site
 * flips it at seven days, but by two the cause is a real failure).
 */
const SCORED_WARNING_SECONDS = 26 * 3600;
const SCORED_CRITICAL_SECONDS = 50 * 3600;

const TASK_LABELS: Record<ChartIndexTask, string> = {
    select: 'Select',
    render: 'Render',
    prune: 'Prune',
    inventory: 'Inventory',
    match: 'Match',
    score: 'Score',
    trending: 'Trending',
};

const TASK_HINTS: Record<ChartIndexTask, string> = {
    select: 'Artifact Hub feed → charts, index.yaml → versions',
    render: 'helm template → workloads → image digests',
    prune: 'retires images no live chart reaches',
    inventory: 'syft → SBOMs (scanner pool, batches)',
    match: 'components → server /internal/match → findings',
    score: 'fold findings → chart scores, samples, deltas',
    trending: 'daily ranking over findings (CronJob)',
};

const ALL_TASKS: ChartIndexTask[] = ['select', 'render', 'prune', 'inventory', 'match', 'score', 'trending'];

type Outcome = 'ok' | 'failed' | 'unfinished' | 'never';

function outcomeOf(run: ChartIndexRun | null): Outcome {
    if (!run) return 'never';
    if (run.finishedAt === null) return 'unfinished';
    return run.ok ? 'ok' : 'failed';
}

const OUTCOME_CONFIG: Record<
    Outcome,
    { icon: typeof Clock; label: string; variant: 'success' | 'danger' | 'accent' | 'muted' }
> = {
    ok: { icon: CheckCircle, label: 'Succeeded', variant: 'success' },
    failed: { icon: XCircle, label: 'Failed', variant: 'danger' },
    unfinished: { icon: Loader, label: 'Unfinished', variant: 'accent' },
    never: { icon: Clock, label: 'Never ran', variant: 'muted' },
};

function OutcomeBadge({ run }: { run: ChartIndexRun | null }) {
    const outcome = outcomeOf(run);
    const cfg = OUTCOME_CONFIG[outcome];
    const Icon = cfg.icon;
    return (
        <Badge variant={cfg.variant}>
            <Icon className={`size-3 mr-1.5 ${outcome === 'unfinished' ? 'animate-spin' : ''}`} />
            {cfg.label}
        </Badge>
    );
}

/* A span between two timestamps, or from one to now while a run is still
   open — the same shape the Jobs tab uses. */
function formatSpan(startedAt: string, finishedAt: string | null): string {
    const seconds = Math.max(
        0,
        Math.floor(((finishedAt ? new Date(finishedAt) : new Date()).getTime() - new Date(startedAt).getTime()) / 1000),
    );
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    if (minutes < 60) return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMin = minutes % 60;
    return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
}

/** "in 3h 12m" for a future instant; "now" once it has passed. */
function formatUntil(iso: string | null): string {
    if (!iso) return '—';
    const seconds = Math.floor((new Date(iso).getTime() - Date.now()) / 1000);
    return seconds <= 0 ? 'now' : `in ${formatLag(seconds)}`;
}

function formatBytes(bytes: number | null): string {
    if (bytes === null) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

/** `findingsNew` → "findings new". The stats are each task's own shape; the labels come from the keys. */
function humanise(key: string): string {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/**
 * A run's `stats` as one line: the flat numbers and booleans, in the
 * order the task wrote them. Nested objects (select's `excluded`) are
 * left to the detail view — a line that tried to say everything would
 * say nothing.
 */
function statsLine(stats: Record<string, unknown>, limit = 7): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(stats)) {
        if (typeof value === 'number') parts.push(`${formatNumber(value)} ${humanise(key)}`);
        else if (typeof value === 'boolean' && value) parts.push(humanise(key));
        if (parts.length >= limit) break;
    }
    return parts.join(' · ');
}

function shortDigest(digest: string): string {
    return digest.replace(/^sha256:/, '').slice(0, 12);
}

// ── Sections ───────────────────────────────────────────────────────────────

function HealthTiles({ data }: { data: ChartIndexStatus }) {
    // Re-derived on a tick so the age keeps counting between refreshes; the tone can cross a threshold while the tab sits open.
    const now = useNow();
    const scoredAgeSeconds = data.freshness
        ? Math.max(0, Math.floor((now - new Date(data.freshness.scoredAt).getTime()) / 1000))
        : null;
    const failing = data.tasks.filter((t) => outcomeOf(t.lastRun) === 'failed');
    const live = data.catalogue.versions.live;
    const im = data.images;

    const backlogTone = (n: number): HealthTone => (n === 0 ? 'good' : 'neutral');

    return (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <HealthTile
                label="Index scored"
                value={scoredAgeSeconds === null ? 'Never' : `${formatLag(scoredAgeSeconds)} ago`}
                tone={
                    scoredAgeSeconds === null
                        ? 'bad'
                        : thresholdTone(scoredAgeSeconds, SCORED_WARNING_SECONDS, SCORED_CRITICAL_SECONDS)
                }
                detail={
                    scoredAgeSeconds === null
                        ? 'No score run has ever succeeded — every public page is empty'
                        : "The last successful score run: what every public page's freshness line says"
                }
            />
            <HealthTile
                label="Render backlog"
                value={live.pending}
                tone={backlogTone(live.pending)}
                detail={`Live versions awaiting helm template · ${formatNumber(data.catalogue.versions.attempted24h)} attempted, ${formatNumber(data.catalogue.versions.rendered24h)} rendered in 24h`}
            />
            <HealthTile
                label="Inventory backlog"
                value={im.byStatus.pending}
                tone={im.staleClaims > 0 ? 'warn' : backlogTone(im.byStatus.pending)}
                detail={
                    im.staleClaims > 0
                        ? `${formatNumber(im.staleClaims)} stale claim${im.staleClaims === 1 ? '' : 's'} — a scanner died mid-syft; the next batch marks them failed`
                        : `Images awaiting an SBOM · ${formatNumber(im.inFlight.length)} in flight · ${formatNumber(im.done24h)} scanned in 24h`
                }
            />
            <HealthTile
                label="Failing tasks"
                value={failing.length}
                tone={failing.length > 0 ? 'bad' : 'good'}
                detail={
                    failing.length > 0
                        ? `Last run failed: ${failing.map((t) => TASK_LABELS[t.task]).join(', ')}`
                        : "Every task's most recent run succeeded, or is still running"
                }
            />
        </div>
    );
}

function PipelineSection({ data }: { data: ChartIndexStatus }) {
    return (
        <div className="space-y-3">
            <TableContainer>
                <Table aria-label="Chart index tasks">
                    <TableHead>
                        <TableHeader>Task</TableHeader>
                        <TableHeader>Last run</TableHeader>
                        <TableHeader hideBelow="sm">Started</TableHeader>
                        <TableHeader hideBelow="md">Duration</TableHeader>
                        <TableHeader hideBelow="lg">Last success</TableHeader>
                        <TableHeader align="end" hideBelow="md">
                            24h ok / failed
                        </TableHeader>
                        <TableHeader hideBelow="xl">Summary</TableHeader>
                    </TableHead>
                    <TableBody>
                        {data.tasks.map((t: ChartIndexTaskStatus) => (
                            <TableRow key={t.task}>
                                <TableCell>
                                    <p className="text-xs sm:text-sm text-ink font-medium">{TASK_LABELS[t.task]}</p>
                                    <p className="hidden sm:block text-xs text-ink-muted">{TASK_HINTS[t.task]}</p>
                                </TableCell>
                                <TableCell className="whitespace-nowrap">
                                    <OutcomeBadge run={t.lastRun} />
                                </TableCell>
                                <TableCell hideBelow="sm" className="text-ink-muted whitespace-nowrap">
                                    {t.lastRun ? formatTimeAgo(t.lastRun.startedAt) : '—'}
                                </TableCell>
                                <TableCell hideBelow="md" className="text-ink-muted tabular-nums whitespace-nowrap">
                                    {t.lastRun ? formatSpan(t.lastRun.startedAt, t.lastRun.finishedAt) : '—'}
                                </TableCell>
                                <TableCell hideBelow="lg" className="text-ink-muted whitespace-nowrap">
                                    {formatTimeAgo(t.lastOkAt)}
                                </TableCell>
                                <TableCell align="end" hideBelow="md" className="tabular-nums whitespace-nowrap">
                                    <span className="text-success">{formatNumber(t.last24h.ok)}</span>
                                    <span className="text-ink-faint"> / </span>
                                    <span className={t.last24h.failed > 0 ? 'text-danger' : 'text-ink-muted'}>
                                        {formatNumber(t.last24h.failed)}
                                    </span>
                                    {t.last24h.unfinished > 0 && (
                                        <span className="text-ink-muted text-xs">
                                            {' '}
                                            +{formatNumber(t.last24h.unfinished)} open
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell hideBelow="xl">
                                    {t.lastRun?.error ? (
                                        <p className="text-xs text-danger max-w-md truncate" title={t.lastRun.error}>
                                            {t.lastRun.error}
                                        </p>
                                    ) : (
                                        <p className="text-xs text-ink-secondary max-w-md truncate">
                                            {t.lastRun ? statsLine(t.lastRun.stats) : ''}
                                        </p>
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            <p className="text-xs text-ink-muted">
                {data.schedules.map((s, i) => (
                    <span key={s.name}>
                        {i > 0 && ' · '}
                        <span className="text-ink-secondary font-medium">{s.name}</span> (
                        {s.tasks.map((t) => TASK_LABELS[t].toLowerCase()).join(' → ')}){' '}
                        <span className="font-mono">{s.cron}</span> UTC, next {formatUntil(s.nextAt)}
                    </span>
                ))}
                {' · '}inventory runs continuously on the scanner pool
            </p>
        </div>
    );
}

function FreshnessCard({ data }: { data: ChartIndexStatus }) {
    const f = data.freshness;
    return (
        <Card
            title="Freshness"
            subtitle="What the public pages cite: the last successful score run and the advisory data behind it"
        >
            {f ? (
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                    <div className="text-ink-muted">Scored</div>
                    <div className="text-ink-secondary font-medium">{formatTimeAgo(f.scoredAt)}</div>
                    <div className="text-ink-muted">OSV synced</div>
                    <div className="text-ink-secondary font-medium">{formatTimeAgo(f.sync?.osvSyncedAt ?? null)}</div>
                    <div className="text-ink-muted">EPSS score date</div>
                    <div className="text-ink-secondary font-medium font-mono">{f.sync?.epssScoreDate ?? '—'}</div>
                    <div className="text-ink-muted">KEV catalog</div>
                    <div className="text-ink-secondary font-medium font-mono">{f.sync?.kevCatalogVersion ?? '—'}</div>
                    <div className="text-ink-muted">helm / syft</div>
                    <div className="text-ink-secondary font-medium font-mono">
                        {f.helmVersion ?? '—'} / {f.syftVersion ?? '—'}
                    </div>
                    <div className="text-ink-muted">Matcher (server)</div>
                    <div className="text-ink-secondary font-medium font-mono">{f.serverVersion ?? '—'}</div>
                </div>
            ) : (
                <p className="text-sm text-ink-muted">No score run has succeeded yet.</p>
            )}
        </Card>
    );
}

function CatalogueSection({ data }: { data: ChartIndexStatus }) {
    const { charts, versions, repoIndexCache, workloads } = data.catalogue;
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                    icon={Ship}
                    label="Charts"
                    value={charts.total}
                    sub={`${formatNumber(charts.selected)} selected · ${formatNumber(charts.official)} official`}
                />
                <StatCard
                    icon={Layers}
                    label="Live versions"
                    value={versions.live.total}
                    sub={`${formatNumber(versions.live.rendered)} rendered · ${formatNumber(versions.live.failed)} failed · ${formatNumber(versions.live.noTarball)} no tarball`}
                />
                <StatCard
                    icon={Boxes}
                    label="Containers rendered"
                    value={workloads.total}
                    sub={`${formatNumber(workloads.unresolved)} unresolved`}
                    tone={workloads.unresolved > 0 ? 'warn' : 'neutral'}
                />
                <StatCard
                    icon={Database}
                    label="index.yaml cache"
                    value={repoIndexCache.repositories}
                    sub={`${formatNumber(repoIndexCache.fetched24h)} fetched in 24h`}
                />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card
                    title="All versions by render status"
                    subtitle={`${formatNumber(versions.total)} versions — the live set plus previous majors and history`}
                >
                    <DistributionBar
                        total={versions.total}
                        emptyMessage="No versions yet"
                        segments={[
                            {
                                key: 'rendered',
                                label: 'Rendered',
                                count: versions.byRenderStatus.rendered,
                                className: 'bg-success-emphasis',
                            },
                            {
                                key: 'pending',
                                label: 'Pending',
                                count: versions.byRenderStatus.pending,
                                className: 'bg-accent-emphasis',
                            },
                            {
                                key: 'failed',
                                label: 'Failed',
                                count: versions.byRenderStatus.failed,
                                className: 'bg-danger-emphasis',
                            },
                        ]}
                    />
                </Card>
                <Card
                    title="App version check"
                    subtitle="Whether the declared appVersion is among the tags the default render resolved"
                >
                    <DistributionBar
                        total={
                            versions.appVersionCheck.matched +
                            versions.appVersionCheck.unmatched +
                            versions.appVersionCheck.unknown +
                            versions.appVersionCheck.unchecked
                        }
                        emptyMessage="Nothing rendered yet"
                        segments={[
                            {
                                key: 'matched',
                                label: 'Matched',
                                count: versions.appVersionCheck.matched,
                                className: 'bg-success-emphasis',
                            },
                            {
                                key: 'unmatched',
                                label: 'Unmatched',
                                count: versions.appVersionCheck.unmatched,
                                className: 'bg-attention-emphasis',
                            },
                            {
                                key: 'unknown',
                                label: 'Unknown',
                                count: versions.appVersionCheck.unknown,
                                className: 'bg-edge-strong',
                            },
                            {
                                key: 'unchecked',
                                label: 'Unchecked',
                                count: versions.appVersionCheck.unchecked,
                                className: 'bg-neutral-emphasis',
                            },
                        ]}
                    />
                </Card>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <ReasonsCard
                    title="Render failures"
                    subtitle="Failed versions by reason (first 140 chars)"
                    reasons={data.catalogue.renderFailures}
                    empty="No failed renders."
                />
                <ReasonsCard
                    title="Unresolved image refs"
                    subtitle="Containers of live versions whose ref did not resolve to a digest"
                    reasons={data.catalogue.resolutionErrors}
                    empty="Every ref resolved."
                />
            </div>
        </div>
    );
}

function ImagesSection({ data }: { data: ChartIndexStatus }) {
    const im = data.images;
    const total = im.byStatus.pending + im.byStatus.done + im.byStatus.failed + im.byStatus.retired;
    const spent = im.failedByAttempts.filter((f) => f.attempts >= im.maxAttempts).reduce((n, f) => n + f.count, 0);
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                    icon={Package}
                    label="SBOMs"
                    value={im.sboms.total}
                    sub={`${formatNumber(im.sboms.components)} components · latest ${formatTimeAgo(im.sboms.latestGeneratedAt)}`}
                />
                <StatCard
                    icon={Radar}
                    label="Matched images"
                    value={im.scanned}
                    sub={
                        im.doneUnscanned > 0
                            ? `${formatNumber(im.doneUnscanned)} inventoried, awaiting the daily match`
                            : 'every inventoried image has a scan'
                    }
                    tone={im.doneUnscanned > 0 ? 'warn' : 'neutral'}
                />
                <StatCard
                    icon={FileWarning}
                    label="Current findings"
                    value={im.currentFindings.total}
                    sub={`${formatNumber(im.currentFindings.kev)} KEV · ${formatNumber(im.currentFindings.exploited)} EPSS ≥ 0.1`}
                />
                <StatCard
                    icon={XCircle}
                    label="Failed images"
                    value={im.byStatus.failed}
                    sub={`${formatNumber(spent)} out of retries · ${formatNumber(im.failed24h)} failed in 24h`}
                    tone={spent > 0 ? 'warn' : 'neutral'}
                />
            </div>

            <Card
                title="Images by inventory status"
                subtitle={`${formatNumber(total)} images (one per digest and platform)${im.oldestPendingAt ? ` · oldest pending first seen ${formatTimeAgo(im.oldestPendingAt)}` : ''}`}
            >
                <DistributionBar
                    total={total}
                    emptyMessage="No images yet"
                    segments={[
                        { key: 'done', label: 'Done', count: im.byStatus.done, className: 'bg-success-emphasis' },
                        {
                            key: 'pending',
                            label: 'Pending',
                            count: im.byStatus.pending,
                            className: 'bg-accent-emphasis',
                        },
                        { key: 'failed', label: 'Failed', count: im.byStatus.failed, className: 'bg-danger-emphasis' },
                        { key: 'retired', label: 'Retired', count: im.byStatus.retired, className: 'bg-edge-strong' },
                    ]}
                />
            </Card>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <Card
                    title="In flight"
                    subtitle="Pending images a scanner has claimed. A claim older than twice the syft timeout is a pod that died on it."
                >
                    {im.inFlight.length === 0 ? (
                        <p className="text-sm text-ink-muted">No image is being scanned right now.</p>
                    ) : (
                        <TableContainer>
                            <Table density="condensed" aria-label="Images in flight">
                                <TableHead>
                                    <TableHeader>Image</TableHeader>
                                    {/* `xl`, not `lg`: this card is half the
                                        content width from `lg` up, so it has
                                        less room at `lg` than it had at `md`. */}
                                    <TableHeader hideBelow="xl">Scanner</TableHeader>
                                    <TableHeader align="end" hideBelow="sm">
                                        Attempt
                                    </TableHeader>
                                    <TableHeader align="end">Claimed</TableHeader>
                                </TableHead>
                                <TableBody>
                                    {im.inFlight.map((c) => (
                                        <TableRow key={`${c.digest}-${c.claimedAt}`}>
                                            <TableCell>
                                                <p className="text-xs sm:text-sm text-ink truncate max-w-48 sm:max-w-xs">
                                                    {c.registry}/{c.repository}
                                                </p>
                                                <p className="text-xs text-ink-muted font-mono">
                                                    {shortDigest(c.digest)}
                                                </p>
                                            </TableCell>
                                            <TableCell hideBelow="xl" className="text-xs text-ink-secondary font-mono">
                                                {c.claimedBy ?? '—'}
                                            </TableCell>
                                            <TableCell
                                                align="end"
                                                hideBelow="sm"
                                                className="tabular-nums text-ink-muted"
                                            >
                                                {c.attempts}
                                            </TableCell>
                                            <TableCell
                                                align="end"
                                                className="whitespace-nowrap tabular-nums text-ink-muted"
                                            >
                                                {formatLag(c.ageSeconds)} ago
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </Card>
                <Card
                    title="Queue by registry"
                    subtitle="Unclaimed pending images with attempts left, as the pool will take them"
                >
                    {im.queueByRegistry.length === 0 ? (
                        <p className="text-sm text-ink-muted">The queue is empty.</p>
                    ) : (
                        <TableContainer>
                            <Table density="condensed" aria-label="Inventory queue by registry">
                                <TableHead>
                                    <TableHeader>Registry</TableHeader>
                                    <TableHeader align="end">Waiting</TableHeader>
                                    <TableHeader align="end" hideBelow="sm">
                                        Top priority
                                    </TableHeader>
                                </TableHead>
                                <TableBody>
                                    {im.queueByRegistry.map((q) => (
                                        <TableRow key={q.registry}>
                                            <TableCell className="text-ink font-mono break-all">{q.registry}</TableCell>
                                            <TableCell align="end" className="tabular-nums text-ink-secondary">
                                                {formatNumber(q.count)}
                                            </TableCell>
                                            <TableCell
                                                align="end"
                                                hideBelow="sm"
                                                className="tabular-nums text-ink-muted"
                                            >
                                                {formatNumber(q.topPriority)} ★
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    )}
                </Card>
            </div>

            <ReasonsCard
                title="Inventory failures"
                subtitle={`Failed images by reason (first 140 chars) · by attempts: ${im.failedByAttempts.map((f) => `${formatNumber(f.count)} × ${f.attempts}`).join(', ') || 'none'} (max ${im.maxAttempts})`}
                reasons={im.failures}
                empty="No failed images."
            />
        </div>
    );
}

function ScoresSection({ data }: { data: ChartIndexStatus }) {
    const sc = data.scores;
    const measuredShare =
        sc.liveVersions.images > 0
            ? `${((sc.liveVersions.measured / sc.liveVersions.images) * 100).toFixed(1)}% of images measured`
            : 'no images';
    return (
        <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
            <StatCard
                icon={Radar}
                label="Scored live versions"
                value={`${formatNumber(sc.liveVersions.scored)} / ${formatNumber(sc.liveVersions.total)}`}
                sub={measuredShare}
            />
            <StatCard
                icon={Clock}
                label="Samples today"
                value={sc.samples.today}
                sub={sc.samples.latestSampledOn ? `latest day ${sc.samples.latestSampledOn}` : 'no samples yet'}
            />
            <StatCard icon={Layers} label="Version deltas" value={sc.deltas} sub="previous major → latest" />
            <StatCard
                icon={Boxes}
                label="Deployed images"
                value={sc.deployedImages.total}
                sub={`${formatNumber(sc.deployedImages.scored)} scored · the /images read model`}
            />
            <StatCard
                icon={TrendingUp}
                label="Trending CVEs"
                value={sc.trending.rows}
                sub={`computed ${formatTimeAgo(sc.trending.computedAt)}`}
            />
            <StatCard
                icon={FileWarning}
                label="Advisories in scope"
                value={sc.advisoryReach.rows}
                sub={`the /vulns index · ${formatTimeAgo(sc.advisoryReach.computedAt)}`}
            />
        </div>
    );
}

function RunDetail({ run, onClose }: { run: ChartIndexRun; onClose: () => void }) {
    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{TASK_LABELS[run.task]} run</h3>
                    <p className="text-xs text-ink-muted mt-0.5 font-mono break-all">{run.id}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="text-xs text-ink-muted hover:text-ink-secondary cursor-pointer shrink-0"
                >
                    Close
                </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-3 text-sm">
                <Field label="Outcome">
                    <OutcomeBadge run={run} />
                </Field>
                <Field label="Started">{new Date(run.startedAt).toLocaleString()}</Field>
                <Field label="Finished">{run.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'}</Field>
                <Field label="Duration">{formatSpan(run.startedAt, run.finishedAt)}</Field>
                <Field label="helm / syft">
                    <span className="font-mono">
                        {run.helmVersion ?? '—'} / {run.syftVersion ?? '—'}
                    </span>
                </Field>
                <Field label="Matcher">
                    <span className="font-mono">{run.serverVersion ?? '—'}</span>
                </Field>
                <Field label="OSV synced">{formatTimeAgo(run.sync?.osvSyncedAt ?? null)}</Field>
                <Field label="EPSS / KEV">
                    <span className="font-mono">
                        {run.sync?.epssScoreDate ?? '—'} / {run.sync?.kevCatalogVersion ?? '—'}
                    </span>
                </Field>
            </div>
            {run.error && (
                <div>
                    <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-1">Error</p>
                    <p className="text-sm text-danger bg-danger-subtle rounded-sm px-3 py-2 whitespace-pre-wrap break-all">
                        {run.error}
                    </p>
                </div>
            )}
            <div>
                <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-1">Stats</p>
                <pre className="text-xs text-ink-secondary bg-surface-muted rounded-sm px-3 py-2 overflow-x-auto">
                    {JSON.stringify(run.stats, null, 2)}
                </pre>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <p className="text-xs text-ink-muted uppercase tracking-wide font-medium mb-0.5">{label}</p>
            <div className="text-ink-secondary">{children}</div>
        </div>
    );
}

function RecentRuns({ runs }: { runs: ChartIndexRun[] }) {
    const [taskFilter, setTaskFilter] = useState<ChartIndexTask | ''>('');
    const [selected, setSelected] = useState<ChartIndexRun | null>(null);
    const shown = taskFilter ? runs.filter((r) => r.task === taskFilter) : runs;

    const chip = (active: boolean) =>
        `text-xs px-2.5 py-1 rounded-full border transition-colors cursor-pointer ${active ? 'bg-ink text-surface border-ink' : 'border-edge text-ink-secondary hover:border-edge-strong'}`;

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-ink-muted font-medium">Task:</span>
                <button type="button" onClick={() => setTaskFilter('')} className={chip(taskFilter === '')}>
                    All
                </button>
                {ALL_TASKS.map((t) => (
                    <button key={t} type="button" onClick={() => setTaskFilter(t)} className={chip(taskFilter === t)}>
                        {TASK_LABELS[t]}
                    </button>
                ))}
            </div>

            {selected && <RunDetail run={selected} onClose={() => setSelected(null)} />}

            <TableContainer>
                {shown.length === 0 ? (
                    <div className="py-10 text-center">
                        <Clock className="mx-auto size-8 text-ink-faint/70" />
                        <p className="mt-3 text-sm text-ink-muted">No runs recorded</p>
                    </div>
                ) : (
                    <Table aria-label="Recent chart index runs">
                        <TableHead>
                            <TableHeader>Task</TableHeader>
                            <TableHeader>Outcome</TableHeader>
                            <TableHeader>Started</TableHeader>
                            <TableHeader hideBelow="sm">Duration</TableHeader>
                            <TableHeader hideBelow="md">Summary</TableHeader>
                        </TableHead>
                        <TableBody>
                            {shown.map((run) => {
                                const isSelected = selected?.id === run.id;
                                return (
                                    <TableRow
                                        key={run.id}
                                        onClick={() => setSelected(isSelected ? null : run)}
                                        selected={isSelected}
                                    >
                                        <TableCell>
                                            <button
                                                type="button"
                                                aria-expanded={isSelected}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelected(isSelected ? null : run);
                                                }}
                                                className="text-xs sm:text-sm text-ink cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                            >
                                                {TASK_LABELS[run.task]}
                                            </button>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap">
                                            <OutcomeBadge run={run} />
                                        </TableCell>
                                        <TableCell className="text-ink-muted whitespace-nowrap">
                                            {formatTimeAgo(run.startedAt)}
                                        </TableCell>
                                        <TableCell
                                            hideBelow="sm"
                                            className="text-ink-muted tabular-nums whitespace-nowrap"
                                        >
                                            {formatSpan(run.startedAt, run.finishedAt)}
                                        </TableCell>
                                        <TableCell hideBelow="md">
                                            {run.error ? (
                                                <p className="text-xs text-danger max-w-md truncate" title={run.error}>
                                                    {run.error}
                                                </p>
                                            ) : (
                                                <p className="text-xs text-ink-secondary max-w-md truncate">
                                                    {statsLine(run.stats)}
                                                </p>
                                            )}
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                        </TableBody>
                    </Table>
                )}
            </TableContainer>
            <p className="text-xs text-ink-muted">
                The last {formatNumber(runs.length)} runs. Inventory rows are scanner batches, so they dominate on a
                backfill day.
            </p>
        </div>
    );
}

function DatabaseSection({ data }: { data: ChartIndexStatus }) {
    const db = data.database;
    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                    icon={HardDrive}
                    label="Database"
                    value={db.name ?? '—'}
                    sub={db.sizeBytes === null ? 'size unavailable' : formatBytes(db.sizeBytes)}
                />
                <StatCard icon={Database} label="Tables" value={db.tables.length} sub="public schema" />
            </div>
            {db.tables.length > 0 && (
                <TableContainer>
                    <Table density="condensed" aria-label="Chart index tables">
                        <TableHead>
                            <TableHeader>Table</TableHeader>
                            <TableHeader align="end">Rows (est.)</TableHeader>
                            <TableHeader align="end">Size</TableHeader>
                        </TableHead>
                        <TableBody>
                            {db.tables.map((t) => (
                                <TableRow key={t.name}>
                                    <TableCell className="font-mono text-ink break-all">{t.name}</TableCell>
                                    <TableCell align="end" className="tabular-nums text-ink-secondary">
                                        {formatNumber(t.rows)}
                                    </TableCell>
                                    <TableCell align="end" className="tabular-nums text-ink-muted">
                                        {formatBytes(t.bytes)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </div>
    );
}

// ── Building blocks ────────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5 space-y-3">
            <div>
                <h3 className="text-sm font-semibold text-ink-secondary">{title}</h3>
                {subtitle && <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>}
            </div>
            {children}
        </div>
    );
}

function ReasonsCard({
    title,
    subtitle,
    reasons,
    empty,
}: {
    title: string;
    subtitle: string;
    reasons: Array<{ reason: string; count: number }>;
    empty: string;
}) {
    return (
        <Card title={title} subtitle={subtitle}>
            {reasons.length === 0 ? (
                <p className="text-sm text-success inline-flex items-center gap-1">
                    <CheckCircle className="size-3.5" /> {empty}
                </p>
            ) : (
                <ul className="space-y-1.5">
                    {reasons.map((r) => (
                        <li key={r.reason} className="flex items-start gap-3 text-xs">
                            <span className="font-medium text-ink-secondary tabular-nums w-14 shrink-0 text-right">
                                {formatNumber(r.count)}
                            </span>
                            <span className="font-mono text-ink-muted break-all">{r.reason}</span>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
    return (
        <section className="space-y-3">
            <div>
                <h2 className="text-sm font-semibold text-ink">{title}</h2>
                <p className="text-xs text-ink-muted">{subtitle}</p>
            </div>
            {children}
        </section>
    );
}

// ── Tab ────────────────────────────────────────────────────────────────────

export function ChartIndexTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<ChartIndexStatus>(
        '/api/admin/chart-index',
        refreshKey,
        onLoadingChange,
    );

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (
                <div className="space-y-8">
                    <HealthTiles data={data} />

                    <Section
                        title="Pipeline"
                        subtitle="One row per worker task: its most recent run and how the last 24 hours went"
                    >
                        <PipelineSection data={data} />
                    </Section>

                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                        <FreshnessCard data={data} />
                        <div className="lg:col-span-2">
                            <Card
                                title="Scores"
                                subtitle="The fold over measured images, per live chart version, and the read models built from it"
                            >
                                <ScoresSection data={data} />
                            </Card>
                        </div>
                    </div>

                    <Section
                        title="Catalogue"
                        subtitle="What select chose from Artifact Hub and how much of it render turned into containers and digests"
                    >
                        <CatalogueSection data={data} />
                    </Section>

                    <Section
                        title="Inventory"
                        subtitle="Images by inventory status, the scanner pool's queue, and what failed"
                    >
                        <ImagesSection data={data} />
                    </Section>

                    <Section
                        title="Recent runs"
                        subtitle="Every task execution writes a row; click one for its stats and provenance"
                    >
                        <RecentRuns runs={data.recentRuns} />
                    </Section>

                    <Section title="Database" subtitle="The charts database as the site's read-only role sees it">
                        <DatabaseSection data={data} />
                    </Section>

                    <p className="text-xs text-ink-muted">
                        Snapshot taken {formatTimeAgo(data.generatedAt)} by the charts site.
                    </p>
                </div>
            )}
        </TabShell>
    );
}
