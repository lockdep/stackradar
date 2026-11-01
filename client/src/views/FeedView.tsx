'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { Button, DaysFilter, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui';
import { ScopeSelect } from '@/components/containers';
import { useResource } from '@/hooks';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { getPlanHistoryDays } from '@/components/organization-settings/constants';
import type { Cluster } from '@/types/cluster';

type ClusterName = Pick<Cluster, 'id' | 'name'>;
import { useFeed } from '@/components/feed/useFeed';
import { groupByDay } from '@/components/feed/dayGroups';
import { FeedDay } from '@/components/feed/FeedDay';

/**
 * The Feed — what changed in the org's fleet, one block per calendar day,
 * newest first.
 *
 * Every line is a *change*: a finding that arrived or left, an image that
 * appeared or went away, a container that moved from one digest to another.
 * Never inventory. The day blocks and the folding of repeats are read-time
 * choices made here, in the viewer's timezone; the server hands back a flat
 * page.
 */

export function FeedView() {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const { organization } = useOrganization();

    /* The cluster scope lives in the URL: a scoped feed is a linkable place. */
    const clusterId = searchParams.get('cluster');
    const setCluster = (id: string | null) => {
        const params = new URLSearchParams(searchParams.toString());
        if (id) params.set('cluster', id);
        else params.delete('cluster');
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname);
    };

    const [days, setDays] = useState(30);
    const { edition } = useRuntimeConfig();
    const maxDays = getPlanHistoryDays(organization?.plan, edition);

    /* The names-only list, not `/api/clusters`: that one folds risk and
       coverage for the whole org, which a scope picker has no use for and
       which can take long enough that the picker seems to be missing. */
    const { data: clusters } = useResource<ClusterName[]>('/api/clusters/names', {
        select: (body) => {
            const list = (body as { clusters?: unknown }).clusters;
            return Array.isArray(list) ? (list as ClusterName[]) : [];
        },
    });
    const { events, error, isLoading, isLoadingMore, hasMore, served, refresh, loadMore } = useFeed(
        Math.min(days, maxDays),
        clusterId,
    );

    const groups = events ? groupByDay(events) : [];
    const showCluster = !clusterId && (clusters?.length ?? 0) > 1;

    return (
        <div>
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h1 className="text-xl font-semibold text-ink">Feed</h1>
                    <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                        What changed in the containers you track, day by day: image changes and what they did to the
                        findings, advisories that landed on a running image, containers that came and went.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {/* Shown even with one cluster: "All clusters" is what tells the reader the scope. */}
                    {clusters && clusters.length > 0 && (
                        <ScopeSelect
                            label="Scope to cluster"
                            value={clusterId}
                            onChange={setCluster}
                            allLabel="All clusters"
                            options={clusters.map((c) => ({ value: c.id, label: c.name }))}
                        />
                    )}
                    <DaysFilter value={Math.min(days, maxDays)} onChange={setDays} maxDays={maxDays} />
                    <Button variant="secondary" onClick={() => void refresh()}>
                        <RefreshCw aria-hidden className="size-4" /> Refresh
                    </Button>
                </div>
            </header>

            <div className="mt-6">
                {isLoading && !events && <LoadingBlock label="Loading the feed…" />}

                {error && !events && (
                    <ErrorBlock title="Failed to load the feed" message={error} onRetry={() => void refresh()} />
                )}

                {events && events.length === 0 && (
                    <p className="py-10 text-center text-sm text-ink-muted">
                        Nothing has changed in the last {served?.days ?? days} days. Image changes, new advisories
                        against running images and containers that come and go land here — one entry per change, never
                        one per finding.
                    </p>
                )}

                {groups.length > 0 && (
                    <ol className="relative ml-1.5 border-l border-edge">
                        {groups.map((group) => (
                            <FeedDay key={group.key} group={group} showCluster={showCluster} />
                        ))}
                    </ol>
                )}

                {hasMore && (
                    <div className="mt-6 flex justify-center">
                        <Button variant="secondary" onClick={() => void loadMore()} disabled={isLoadingMore}>
                            {isLoadingMore ? <Spinner size="sm" /> : null} Load older
                        </Button>
                    </div>
                )}

                {events && events.length > 0 && !hasMore && served && served.days < days && (
                    <p className="mt-6 text-center text-xs text-ink-muted">
                        Your plan keeps {served.historyDays} days of history.
                    </p>
                )}
            </div>
        </div>
    );
}
