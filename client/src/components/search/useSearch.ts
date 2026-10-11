'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { PALETTE_DEBOUNCE_MS } from '@/lib/constants';
import type { SearchResponse } from './types';

/** Below this the server answers 400, so the client does not ask. */
export const SEARCH_MIN_CHARS = 2;

export type SearchStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The last response, with the term it answered; a failure keeps the results it had. */
type Answer = { term: string; results: SearchResponse | null; failed: boolean };

/**
 * The palette's fetch: debounced, aborting the in-flight request on every
 * change, and ignoring any response for a term that is no longer the one in
 * the box. The previous results stay on screen while the next ones load, so
 * typing never flashes an empty list.
 *
 * Status is derived from the answer on record against the current term —
 * "loading" is "the answer is for another term" — so a keystroke is a
 * render, not a setState inside the effect. The abort on cleanup is what
 * makes the derivation sound: a response for a term that is no longer
 * current never lands.
 *
 * `enabled` is the dialog being open — closed, nothing fires and the last
 * results are dropped.
 */
export function useSearch(query: string, enabled: boolean): { results: SearchResponse | null; status: SearchStatus } {
    const term = query.trim();
    const active = enabled && term.length >= SEARCH_MIN_CHARS;
    const [answer, setAnswer] = useState<Answer | null>(null);

    useEffect(() => {
        if (!active) return;
        const controller = new AbortController();
        const handle = setTimeout(async () => {
            try {
                const params = new URLSearchParams({ q: term });
                const data = await apiFetch<SearchResponse>(`/api/search?${params}`, { signal: controller.signal });
                if (controller.signal.aborted) return;
                setAnswer({ term, results: data, failed: false });
            } catch (error) {
                if (controller.signal.aborted) return;
                void error;
                setAnswer((prev) => ({ term, results: prev?.results ?? null, failed: true }));
            }
        }, PALETTE_DEBOUNCE_MS);

        return () => {
            clearTimeout(handle);
            controller.abort();
        };
    }, [term, active]);

    if (!active) return { results: null, status: 'idle' };
    if (answer?.term === term) return { results: answer.results, status: answer.failed ? 'error' : 'ready' };
    return { results: answer?.results ?? null, status: 'loading' };
}
