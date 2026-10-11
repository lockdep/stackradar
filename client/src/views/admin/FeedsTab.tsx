'use client';

import { CheckCircle, AlertCircle } from 'lucide-react';
import { useTabData } from './useTabData';
import { TabShell } from './Shared';
import { formatTimeAgo, formatNumber } from './utils';
import type { FeedsData } from './types';

/**
 * The three daily feed syncs beside the OSV mirror: EPSS and KEV, which
 * decorate advisories the mirror already holds, and the Artifact Hub chart
 * mirror. Each keeps one overwritten state row — last run only, no history —
 * so this tab is three cards, not three tables.
 */
export function FeedsTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<FeedsData>('/api/admin/feeds', refreshKey, onLoadingChange);

    return (
        <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
            {data && (
                <div className="space-y-4">
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                        <FeedCard
                            title="EPSS"
                            subtitle="Exploitation probability scores (FIRST.org)"
                            stale={data.epss.stale}
                            lastSyncedAt={data.epss.state?.lastSyncedAt ?? null}
                            lastError={data.epss.state?.lastError ?? null}
                            updatedAt={data.epss.state?.updatedAt ?? null}
                        >
                            {data.epss.state && (
                                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                                    <div className="text-ink-muted">Score date</div>
                                    <div className="text-ink-secondary font-medium font-mono">
                                        {data.epss.state.lastScoreDate ?? '—'}
                                    </div>
                                    <div className="text-ink-muted">Rows in file</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.epss.state.rowsInFile)}
                                    </div>
                                    <div className="text-ink-muted">Matched</div>
                                    {/* Unmatched is expected to be huge (EPSS scores every CVE, the mirror
                                        holds only ecosystem advisories) — a matched count collapsing to zero
                                        is the signal the alias join broke, so that is what gets the red. */}
                                    <div
                                        className={`font-medium ${collapsed(data.epss.state.rowsMatched, data.epss.state.rowsInFile) ? 'text-danger' : 'text-ink-secondary'}`}
                                    >
                                        {fmt(data.epss.state.rowsMatched)}
                                    </div>
                                    <div className="text-ink-muted">Unmatched</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.epss.state.rowsUnmatched)}
                                    </div>
                                    <div className="text-ink-muted">Advisories scored</div>
                                    <div className="text-ink-secondary font-medium">
                                        {formatNumber(data.epss.advisoriesWithScore)}
                                    </div>
                                </div>
                            )}
                        </FeedCard>

                        <FeedCard
                            title="KEV"
                            subtitle="Known Exploited Vulnerabilities (CISA)"
                            stale={data.kev.stale}
                            lastSyncedAt={data.kev.state?.lastSyncedAt ?? null}
                            lastError={data.kev.state?.lastError ?? null}
                            updatedAt={data.kev.state?.updatedAt ?? null}
                        >
                            {data.kev.state && (
                                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                                    <div className="text-ink-muted">Catalog version</div>
                                    <div className="text-ink-secondary font-medium font-mono">
                                        {data.kev.state.catalogVersion ?? '—'}
                                    </div>
                                    <div className="text-ink-muted">Released</div>
                                    <div className="text-ink-secondary font-medium">
                                        {formatTimeAgo(data.kev.state.releasedAt)}
                                    </div>
                                    <div className="text-ink-muted">Entries in catalog</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.kev.state.entriesInCatalog)}
                                    </div>
                                    <div className="text-ink-muted">Matched</div>
                                    <div
                                        className={`font-medium ${collapsed(data.kev.state.entriesMatched, data.kev.state.entriesInCatalog) ? 'text-danger' : 'text-ink-secondary'}`}
                                    >
                                        {fmt(data.kev.state.entriesMatched)}
                                    </div>
                                    {/* Withdrawal is rare but has to propagate — a stale KEV listing pins
                                        exploitability at 1.0. Non-zero here is the sync doing its job. */}
                                    <div className="text-ink-muted">Cleared this run</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.kev.state.entriesCleared)}
                                    </div>
                                    <div className="text-ink-muted">Advisories listed</div>
                                    <div className="text-ink-secondary font-medium">
                                        {formatNumber(data.kev.advisoriesListed)}
                                    </div>
                                </div>
                            )}
                        </FeedCard>

                        <FeedCard
                            title="Artifact Hub"
                            subtitle="Helm chart mirror + attribution"
                            stale={data.artifactHub.stale}
                            lastSyncedAt={data.artifactHub.state?.lastSyncedAt ?? null}
                            lastError={data.artifactHub.state?.lastError ?? null}
                            updatedAt={data.artifactHub.state?.updatedAt ?? null}
                        >
                            {data.artifactHub.state && (
                                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
                                    <div className="text-ink-muted">Packages in dump</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.packagesInDump)}
                                    </div>
                                    <div className="text-ink-muted">Applied</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.packagesApplied)}
                                    </div>
                                    <div className="text-ink-muted">Mirror rows</div>
                                    <div className="text-ink-secondary font-medium">
                                        {formatNumber(data.artifactHub.mirrorPackages)}
                                    </div>
                                    {/* The attribution pass is a separate write after the mirror refresh —
                                        dashes here with a fresh sync mean it has not run, not that it found nothing. */}
                                    <div className="text-ink-muted">Charts examined</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.chartsExamined)}
                                    </div>
                                    <div className="text-ink-muted">Attributed</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.attributionsWritten)}
                                    </div>
                                    <div className="text-ink-muted">Refused</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.attributionsRefused)}
                                    </div>
                                    <div className="text-ink-muted">Repos auto-added</div>
                                    <div className="text-ink-secondary font-medium">
                                        {fmt(data.artifactHub.state.reposAutoAdded)}
                                    </div>
                                    <div className="text-ink-muted">Live attributions</div>
                                    <div className="text-ink-secondary font-medium">
                                        {formatNumber(data.artifactHub.attributions)}
                                    </div>
                                </div>
                            )}
                        </FeedCard>
                    </div>

                    <p className="text-xs text-ink-muted">
                        A feed counts as stale after {data.staleAfterHours}h without a successful sync — each publishes
                        daily, so a single missed run is a slipped schedule, not a broken pipeline.
                    </p>
                </div>
            )}
        </TabShell>
    );
}

function fmt(n: number | null): string {
    return n === null ? '—' : formatNumber(n);
}

/** Zero matches against a non-empty feed: the join broke, not the feed. */
function collapsed(matched: number | null, total: number | null): boolean {
    return matched === 0 && total !== null && total > 0;
}

function FeedCard({
    title,
    subtitle,
    stale,
    lastSyncedAt,
    lastError,
    updatedAt,
    children,
}: {
    title: string;
    subtitle: string;
    stale: boolean;
    lastSyncedAt: string | null;
    lastError: string | null;
    /** When the row last moved at all — with `lastError` set this is the failed attempt. */
    updatedAt: string | null;
    children: React.ReactNode;
}) {
    const neverSynced = lastSyncedAt === null;

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5 space-y-3">
            <div>
                <h2 className="text-sm font-semibold text-ink-secondary">{title}</h2>
                <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>
            </div>

            <div className="flex items-center gap-2">
                {stale ? (
                    <AlertCircle className={`size-4 ${neverSynced ? 'text-ink-muted' : 'text-attention'}`} />
                ) : (
                    <CheckCircle className="size-4 text-success" />
                )}
                <span className="text-sm font-medium text-ink-secondary">
                    {neverSynced ? 'Never synced' : stale ? 'Stale' : 'Fresh'}
                </span>
                {!neverSynced && (
                    <span className="text-xs text-ink-muted ml-auto">synced {formatTimeAgo(lastSyncedAt)}</span>
                )}
            </div>

            {children}

            {lastError && (
                <div className="rounded-md bg-danger-subtle border border-danger-muted p-3 space-y-1">
                    {/* A failed run leaves lastSyncedAt alone, so the figures above are
                        from the last success — say when the failure actually happened. */}
                    <p className="text-xs font-medium text-danger">
                        Last attempt failed ({formatTimeAgo(updatedAt)}); figures are from the last successful run.
                    </p>
                    <p className="text-xs text-danger font-mono break-all">{lastError}</p>
                </div>
            )}
        </div>
    );
}
