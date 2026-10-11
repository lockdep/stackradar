'use client';

import { useEffect, useRef } from 'react';

/** Data older than this when the user returns is worth refetching. */
export const DEFAULT_STALE_AFTER_MS = 60_000;

/** Collapses the visibilitychange/focus pair that a single tab switch fires. */
const DEDUPE_MS = 1_000;

/**
 * Refetches when the user comes back to the tab and what's on screen has gone
 * stale.
 *
 * This is the cheap half of "the page shouldn't need a manual refresh": nothing
 * runs while the tab sits in the background, and a user flicking between tabs
 * pays nothing because `lastUpdated` is still fresh. Background *intervals* are
 * the expensive half and are deliberately not what this does — see
 * `usePollWhile` for the narrow cases that earn one.
 */
export function useRevalidateOnFocus(
    revalidate: () => void | Promise<void>,
    {
        lastUpdated,
        staleAfterMs = DEFAULT_STALE_AFTER_MS,
        enabled = true,
    }: {
        /** When the on-screen data was last fetched; `null` means "never, so always refetch". */
        lastUpdated: Date | null;
        staleAfterMs?: number;
        enabled?: boolean;
    },
) {
    /* Both are read inside a listener that must not be torn down and rebuilt on
       every refresh — which is exactly what putting them in the dep array would
       do, since `lastUpdated` changes on each fetch. */
    const revalidateRef = useRef(revalidate);
    const lastUpdatedRef = useRef(lastUpdated);
    useEffect(() => {
        revalidateRef.current = revalidate;
        lastUpdatedRef.current = lastUpdated;
    });

    useEffect(() => {
        if (!enabled) return;

        let lastAttempt = 0;

        const maybeRevalidate = () => {
            if (document.visibilityState !== 'visible') return;

            const now = Date.now();
            if (now - lastAttempt < DEDUPE_MS) return;

            const last = lastUpdatedRef.current;
            if (last && now - last.getTime() < staleAfterMs) return;

            lastAttempt = now;
            void revalidateRef.current();
        };

        document.addEventListener('visibilitychange', maybeRevalidate);
        window.addEventListener('focus', maybeRevalidate);
        return () => {
            document.removeEventListener('visibilitychange', maybeRevalidate);
            window.removeEventListener('focus', maybeRevalidate);
        };
    }, [enabled, staleAfterMs]);
}
