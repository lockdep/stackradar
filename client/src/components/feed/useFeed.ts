'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api-client';
import type { FeedEvent, FeedPage } from '@/types/feed';

/** What the feed has loaded for one scope (a `days` window and a cluster, or all of them). */
type Loaded = {
    scope: string;
    events: FeedEvent[];
    nextCursor: string | null;
    served: { days: number; historyDays: number };
};

/**
 * The Feed page's data: the first page on mount (and whenever `days` or the
 * cluster scope changes), further pages appended on demand via the server's
 * keyset cursor. Not `useResource`, because that hook holds one response and
 * the feed accumulates them.
 *
 * What is loaded is keyed by scope, so a scope change reads as "loading" the
 * moment it happens rather than as the previous scope's events under the new
 * filter; nothing has to be reset when the inputs move.
 */
export function useFeed(days: number, clusterId: string | null) {
    const scope = `${days}:${clusterId ?? ''}`;
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    const page = loaded && loaded.scope === scope ? loaded : null;
    const error = failure && failure.scope === scope ? failure.message : null;
    const isLoading = (page === null && error === null) || isRefreshing;

    /* Latest-wins: a slow page for the old scope must never land on the new one. */
    const ticket = useRef(0);

    const url = useCallback(
        (cursor: string | null) => {
            const params = new URLSearchParams({ days: String(days), limit: '200' });
            if (clusterId) params.set('cluster', clusterId);
            if (cursor) params.set('cursor', cursor);
            return `/api/feed?${params.toString()}`;
        },
        [days, clusterId],
    );

    const fetchPage = useCallback((cursor: string | null): Promise<FeedPage> => apiFetch<FeedPage>(url(cursor)), [url]);

    const load = useCallback(() => {
        const id = ++ticket.current;
        return fetchPage(null).then(
            (first) => {
                if (id !== ticket.current) return;
                setLoaded({
                    scope,
                    events: first.events,
                    nextCursor: first.nextCursor,
                    served: { days: first.days, historyDays: first.historyDays },
                });
                setFailure(null);
            },
            (err: unknown) => {
                if (id !== ticket.current) return;
                setFailure({ scope, message: errorMessage(err, 'Failed to load') });
            },
        );
    }, [fetchPage, scope]);

    const refresh = useCallback(async () => {
        setIsRefreshing(true);
        setFailure(null);
        try {
            await load();
        } finally {
            setIsRefreshing(false);
        }
    }, [load]);

    const nextCursor = page?.nextCursor ?? null;
    const loadMore = useCallback(async () => {
        if (!nextCursor || isLoadingMore) return;
        const id = ticket.current;
        setIsLoadingMore(true);
        try {
            const next = await fetchPage(nextCursor);
            if (id !== ticket.current) return;
            setLoaded((prev) =>
                prev && prev.scope === scope
                    ? { ...prev, events: [...prev.events, ...next.events], nextCursor: next.nextCursor }
                    : prev,
            );
        } catch (err) {
            if (id !== ticket.current) return;
            setFailure({ scope, message: errorMessage(err, 'Failed to load') });
        } finally {
            if (id === ticket.current) setIsLoadingMore(false);
        }
    }, [fetchPage, nextCursor, isLoadingMore, scope]);

    useEffect(() => {
        void load();
    }, [load]);

    return {
        events: page?.events ?? null,
        error,
        isLoading,
        isLoadingMore,
        hasMore: nextCursor !== null,
        served: page?.served ?? null,
        refresh,
        loadMore,
    };
}
