'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronRight, ShieldAlert } from 'lucide-react';
import { TotalRiskChip } from '@/components/ui';
import { severityDotClass, type SeverityKey } from '@/components/ui/SeveritySparkline';
import { AuthFailedBadge, AwaitingBadge } from '@/components/clusters/ClusterTable';
import { ScannerDot, getScannerHealth, type ScannerHealth } from '@/components/clusters/ScannerDot';
import { useNow } from '@/hooks';
import { TOTAL_RISK_HINT, type RiskBand } from '@/lib/risk';
import { formatRelativeTime } from '@/utils/formatters';
import type { Cluster } from '@/types/cluster';
import type { Container } from '@/types/container';

const SEVERITIES: SeverityKey[] = ['critical', 'high', 'medium', 'low'];

type SeverityCounts = Record<SeverityKey, number>;

interface ClusterRow {
    cluster: Cluster;
    /** Running containers in the cluster, from the live container rows. */
    containers: number;
    /** Distinct findings by severity, counted once per image. */
    severity: SeverityCounts;
    /** False until at least one container in the cluster has a completed scan. */
    scanned: boolean;
}

/* Worst band first when ranking: the total is a magnitude (ADR 0007), so two
   clusters are ordered by how bad their worst finding is before by how much
   they carry. */
const BAND_RANK: Record<RiskBand, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

const SCANNER_LABEL: Record<ScannerHealth, string> = {
    active: 'Scanner active',
    stale: 'Scanner seen',
    offline: 'Scanner offline',
    waiting: 'Waiting for scanner',
};

/**
 * Per-cluster posture, summed from the same live container rows the rest of the
 * Dashboard reads.
 *
 * One row per cluster rather than a four-column table: the question this
 * section answers is "which cluster needs me first", and a row that carries
 * the Risk Score, the worst-finding band, the severity mix and the scanner's
 * state answers it in one glance where a Critical/High pair did not. Rows are
 * ranked worst-first, and the numbers a reader compares — the score, the
 * severity counts — sit in fixed columns so the eye can run down them.
 *
 * Severity counts come from the caller's containers array (one source, one
 * refresh, no per-cluster fan-out); the Risk Score comes from the cluster
 * payload, where the server folded it over the same deployed images.
 */
export function ClusterSummarySection({
    clusters,
    containers: allContainers,
}: {
    clusters: Cluster[];
    containers: Container[];
}) {
    // Re-renders on a schedule so the scanner dot and its age stay truthful.
    useNow();

    const rows = useMemo<ClusterRow[]>(() => {
        const byCluster = new Map<
            string,
            { containers: number; severity: SeverityCounts; scanned: boolean; images: Set<string> }
        >();
        for (const w of allContainers) {
            let agg = byCluster.get(w.clusterId);
            if (!agg) {
                agg = {
                    containers: 0,
                    severity: { critical: 0, high: 0, medium: 0, low: 0 },
                    scanned: false,
                    images: new Set(),
                };
                byCluster.set(w.clusterId, agg);
            }
            agg.containers++;
            if (!w.vulnerabilities) continue;
            agg.scanned = true;
            /* Counted once per image. Findings belong to a digest, so a cluster
               running one vulnerable base image in twelve namespaces has one
               critical to fix, not twelve. */
            if (agg.images.has(w.imageId)) continue;
            agg.images.add(w.imageId);
            for (const s of SEVERITIES) agg.severity[s] += w.vulnerabilities[s];
        }

        const built = clusters.map((cluster) => {
            const agg = byCluster.get(cluster.id);
            return {
                cluster,
                containers: agg?.containers ?? 0,
                severity: agg?.severity ?? { critical: 0, high: 0, medium: 0, low: 0 },
                scanned: agg?.scanned ?? false,
            };
        });

        // Most urgent first; an unscanned cluster has no rank to earn, so it
        // sorts below a scanned one with zero findings rather than above it.
        built.sort(
            (a, b) =>
                Number(b.scanned) - Number(a.scanned) ||
                BAND_RANK[b.cluster.risk.band] - BAND_RANK[a.cluster.risk.band] ||
                b.cluster.risk.score - a.cluster.risk.score ||
                a.cluster.name.localeCompare(b.cluster.name),
        );
        return built;
    }, [clusters, allContainers]);

    if (rows.length === 0) return null;

    return (
        /* A hairline above, like the one under the page header and the
           history-window row: this is the per-cluster drill-down of the
           summary above it, and without a rule the Clusters heading read as
           a fifth Trends card. */
        <section className="mt-8 border-t border-edge pt-6" aria-labelledby="dashboard-clusters-heading">
            <div className="mb-3 flex items-baseline justify-between gap-4">
                <h2 id="dashboard-clusters-heading" className="text-sm font-semibold text-ink-secondary">
                    Clusters
                    <span className="ml-1.5 font-normal tabular-nums text-ink-muted">{rows.length}</span>
                </h2>
                <Link
                    href="/clusters"
                    className="inline-flex items-center gap-1 rounded-sm text-xs text-ink-muted hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                >
                    Manage clusters
                    <ArrowRight aria-hidden="true" className="size-3" />
                </Link>
            </div>
            <ul className="divide-y divide-edge overflow-hidden rounded-md border border-edge bg-surface-raised shadow-resting">
                {rows.map((row) => (
                    <ClusterRowItem key={row.cluster.id} row={row} />
                ))}
            </ul>
        </section>
    );
}

function ClusterRowItem({ row: { cluster, containers, severity, scanned } }: { row: ClusterRow }) {
    const health = getScannerHealth(cluster.scannerLastSeenAt);
    const scannerLabel =
        health === 'stale' || health === 'offline'
            ? `${SCANNER_LABEL[health]} ${formatRelativeTime(cluster.scannerLastSeenAt)}`
            : SCANNER_LABEL[health];
    const href = `/clusters/${cluster.id}`;

    /* Both halves of the ratio come from the cluster's own coverage counts,
       never the client-side container count as numerator — that would compare
       a number including no-longer-running containers against one that does
       not, and can render "48 of 47". */
    const partial =
        cluster.discoveredWorkloads !== null &&
        cluster.scannedWorkloads !== null &&
        cluster.discoveredWorkloads > cluster.scannedWorkloads;
    const coverageLabel = partial
        ? `${cluster.scannedWorkloads!.toLocaleString()} of ${cluster.discoveredWorkloads!.toLocaleString()} containers scanned`
        : `${containers.toLocaleString()} container${containers === 1 ? '' : 's'}`;

    /* A dash until something is scanned: a total of 0 is a claim ("checked,
       clean"), and an unscanned cluster has earned no claim. Findings alone are
       also enough — a scanner too old to report inventory leaves
       `scannedWorkloads` null while SBOMs and findings exist. */
    const hasRisk = scanned || cluster.risk.findingCount > 0 || Boolean(cluster.scannedWorkloads);
    const riskTitle = hasRisk
        ? [
              `Risk Score ${Math.round(cluster.risk.score).toLocaleString()} — summed over ${cluster.risk.findingCount} finding${cluster.risk.findingCount === 1 ? '' : 's'}`,
              cluster.risk.topFinding
                  ? `Worst finding: ${cluster.risk.topFinding.vulnId} (${Math.round(cluster.risk.topFinding.risk)}/100)`
                  : null,
              cluster.risk.kevCount > 0 ? `${cluster.risk.kevCount} on CISA KEV` : null,
              TOTAL_RISK_HINT,
          ]
              .filter(Boolean)
              .join('\n')
        : undefined;

    return (
        /* The name link is stretched over the whole row (`after:inset-0`), so
           the row is one click target without nesting an anchor inside an
           anchor — the auth-failed badge is itself a link and stays reachable
           above it (`relative z-10`). */
        <li className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 px-4 py-3.5 hover:bg-surface-hover focus-within:bg-surface-hover sm:grid-cols-[minmax(0,1fr)_minmax(11rem,14rem)_6.5rem_1rem]">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <ScannerDot health={health} />
                    <Link
                        href={href}
                        className="truncate text-sm font-semibold text-ink after:absolute after:inset-0 after:content-[''] focus:outline-none"
                    >
                        {cluster.name}
                    </Link>
                    <span className="relative z-10 inline-flex items-center gap-1.5">
                        {containers === 0 && !cluster.scannerLastSeenAt && <AwaitingBadge />}
                        {cluster.registryAuthFailedWorkloads > 0 && <AuthFailedBadge cluster={cluster} />}
                    </span>
                </div>
                <p className="mt-1 truncate text-xs text-ink-muted">
                    {scannerLabel}
                    <span aria-hidden="true"> · </span>
                    {/* The cluster's rows on the org-wide Containers page,
                        preselected. `relative z-10` lifts it above the name
                        link stretched over the row, like the badges. */}
                    <Link
                        href={`/containers?cluster=${encodeURIComponent(cluster.id)}`}
                        className={`relative z-10 underline-offset-2 hover:underline ${partial ? 'text-attention' : 'hover:text-ink-secondary'}`}
                        title={
                            partial
                                ? 'Discovered by the scanner, SBOM not generated yet'
                                : "See this cluster's containers"
                        }
                    >
                        {coverageLabel}
                    </Link>
                    {cluster.scannerVersion && (
                        <>
                            <span aria-hidden="true"> · </span>
                            <span className="font-mono">{cluster.scannerVersion}</span>
                        </>
                    )}
                </p>
            </div>

            {/* Mobile: second row, full width. Desktop: its own column. */}
            <div className="col-span-2 sm:col-span-1">
                {scanned ? (
                    <SeverityMix counts={severity} />
                ) : (
                    <p className="text-xs text-ink-muted">No completed scan yet</p>
                )}
            </div>

            <div className="col-start-2 row-start-1 text-right sm:col-start-3">
                <div className="inline-flex items-center gap-1.5">
                    {hasRisk && cluster.risk.kevCount > 0 && (
                        <span
                            title={`${cluster.risk.kevCount} confirmed exploited in the wild (CISA KEV)`}
                            className="inline-flex shrink-0 text-danger"
                        >
                            <ShieldAlert aria-hidden="true" className="size-3.5" />
                            <span className="sr-only">{cluster.risk.kevCount} on CISA KEV</span>
                        </span>
                    )}
                    <TotalRiskChip
                        score={hasRisk ? cluster.risk.score : null}
                        band={cluster.risk.band}
                        title={riskTitle}
                        className="text-xl leading-none"
                    />
                </div>
                <p className="mt-1 text-[11px] text-ink-muted">Risk Score</p>
            </div>

            <ChevronRight
                aria-hidden="true"
                className="hidden size-4 text-ink-faint group-hover:text-ink-secondary sm:block"
            />
        </li>
    );
}

/**
 * The severity mix: a stacked bar for the proportions, four counts for the
 * numbers. The bar is what makes two clusters comparable at a glance — a
 * cluster that is mostly red reads differently from one that is mostly grey
 * even when their totals match — and the counts beneath are what the reader
 * quotes. Zero counts are dimmed rather than dropped so the four columns stay
 * in the same place on every row.
 */
function SeverityMix({ counts }: { counts: SeverityCounts }) {
    const total = SEVERITIES.reduce((n, s) => n + counts[s], 0);
    return (
        <div>
            <div
                className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-track"
                role="img"
                aria-label={SEVERITIES.map((s) => `${counts[s]} ${s}`).join(', ')}
            >
                {total > 0 &&
                    SEVERITIES.map((s) =>
                        counts[s] > 0 ? (
                            <span
                                key={s}
                                className={`${severityDotClass[s]} min-w-0.5`}
                                style={{ flexGrow: counts[s] }}
                            />
                        ) : null,
                    )}
            </div>
            <dl className="mt-1.5 grid grid-cols-4 gap-x-2 text-xs tabular-nums">
                {SEVERITIES.map((s) => (
                    <div
                        key={s}
                        className={`flex items-center gap-1 ${counts[s] > 0 ? 'text-ink-secondary' : 'text-ink-faint'}`}
                    >
                        <dt className="flex items-center">
                            <span
                                aria-hidden="true"
                                className={`size-1.5 rounded-full ${counts[s] > 0 ? severityDotClass[s] : 'bg-ink-faint'}`}
                            />
                            <span className="sr-only">{s}</span>
                        </dt>
                        <dd title={`${counts[s].toLocaleString()} ${s}`}>{counts[s].toLocaleString()}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
