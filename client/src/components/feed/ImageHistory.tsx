'use client';

import { RefreshCw } from 'lucide-react';
import { Button, ErrorBlock, LoadingBlock, Spinner } from '@/components/ui';
import { useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { getPlanHistoryDays } from '@/components/organization-settings/constants';
import type { FeedEvent } from '@/types/feed';
import { groupByDay } from './dayGroups';
import { FeedDay } from './FeedDay';
import { useFeed } from './useFeed';

/**
 * One image's history — the image page's History tab. The Feed, scoped to a
 * digest: when a container first ran it, when it was first scanned and with
 * what, every advisory change against it while it ran, and the moves on and
 * off it. The answer to "would this have told me earlier?" on one page,
 * read from the same log and drawn with the same rows as `/feed`.
 *
 * The whole history window the plan keeps, not the Feed's thirty-day
 * default: an image's history is short, and the oldest line is the one the
 * question is about.
 */

export const IMAGE_HISTORY_EMPTY = 'No events recorded for this image yet.';

export interface ImageHistoryListProps {
    /** Null while the first page loads or failed. */
    events: FeedEvent[] | null;
    error: string | null;
    isLoading: boolean;
    isLoadingMore: boolean;
    hasMore: boolean;
    /** The window the server actually served; null until the first page lands. */
    served: { days: number; historyDays: number } | null;
    refresh: () => Promise<void> | void;
    loadMore: () => Promise<void> | void;
}

/** The tab's body, given the page — what the tests render. */
export function ImageHistoryList({
    events,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    served,
    refresh,
    loadMore,
}: ImageHistoryListProps) {
    /* The first scan stays in: it is this image's own timeline. One image is
       one cluster's (ADR 0006), so no cluster column. */
    const groups = events ? groupByDay(events, { firstScans: true }) : [];

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <p className="max-w-2xl text-sm text-ink-muted">
                    What happened to this image, day by day: when it first ran here and was first scanned, advisories
                    that landed on it while it ran, and the containers that moved onto and off it.
                    {served && <> The last {served.historyDays} days.</>}
                </p>
                {events && (
                    <Button variant="secondary" onClick={() => void refresh()}>
                        <RefreshCw aria-hidden className="size-4" /> Refresh
                    </Button>
                )}
            </div>

            {isLoading && !events && <LoadingBlock label="Loading the history…" />}

            {error && !events && (
                <ErrorBlock title="Failed to load the history" message={error} onRetry={() => void refresh()} />
            )}

            {events && groups.length === 0 && (
                <p className="py-10 text-center text-sm text-ink-muted">{IMAGE_HISTORY_EMPTY}</p>
            )}

            {groups.length > 0 && (
                <ol aria-label="History of this image" className="relative ml-1.5 border-l border-edge">
                    {groups.map((group) => (
                        <FeedDay key={group.key} group={group} showCluster={false} defaultOpen />
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
        </div>
    );
}

export function ImageHistory({ imageId }: { imageId: string }) {
    const { organization } = useOrganization();
    const { edition } = useRuntimeConfig();
    const days = getPlanHistoryDays(organization?.plan, edition);
    const feed = useFeed(days, null, imageId);
    return <ImageHistoryList {...feed} />;
}
