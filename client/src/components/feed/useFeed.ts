'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, errorMessage } from '@/lib/api-client';
import type { FeedEvent, FeedPage } from '@/types/feed';

/**
 * The Feed page's data: the first page on mount (and whenever `days` or the
 * cluster scope changes), further pages appended on demand via the server's
 * keyset cursor. Not `useResource`, because that hook holds one response and
 * the feed accumulates them.
 */
export function useFeed(days: number, clusterId: string | null) {
    const [events, setEvents] = useState<FeedEvent[] | null>(null);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [served, setServed] = useState<{ days: number; historyDays: number } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

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

    const load = useCallback(async () => {
        const id = ++ticket.current;
        setIsLoading(true);
        setError(null);
        try {
            const page = await fetchPage(null);
            if (id !== ticket.current) return;
            setEvents(page.events);
            setNextCursor(page.nextCursor);
            setServed({ days: page.days, historyDays: page.historyDays });
        } catch (err) {
            if (id !== ticket.current) return;
            setError(errorMessage(err, 'Failed to load'));
        } finally {
            if (id === ticket.current) setIsLoading(false);
        }
    }, [fetchPage]);

    const loadMore = useCallback(async () => {
        if (!nextCursor || isLoadingMore) return;
        const id = ticket.current;
        setIsLoadingMore(true);
        try {
            const page = await fetchPage(nextCursor);
            if (id !== ticket.current) return;
            setEvents((prev) => [...(prev ?? []), ...page.events]);
            setNextCursor(page.nextCursor);
        } catch (err) {
            if (id !== ticket.current) return;
            setError(errorMessage(err, 'Failed to load'));
        } finally {
            if (id === ticket.current) setIsLoadingMore(false);
        }
    }, [fetchPage, nextCursor, isLoadingMore]);

    useEffect(() => {
        void load();
    }, [load]);

    return { events, error, isLoading, isLoadingMore, hasMore: nextCursor !== null, served, refresh: load, loadMore };
}
