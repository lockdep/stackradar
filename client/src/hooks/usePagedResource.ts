'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { reloadIfSessionLost } from '@/lib/session-lost';
import { PAGE_SIZE, SEARCH_DEBOUNCE_MS } from '@/lib/constants';

/** The query one page of a server-paged, server-searched table asks for. */
export type PagedQuery = {
    limit: number;
    offset: number;
    /** The committed (debounced, trimmed) search — not each keystroke. */
    search: string;
};

export type UsePagedResourceOptions = {
    /**
     * Whose data this is (the cluster id). Data from another context never
     * shows — the component instance survives a cluster switch (same route,
     * new param), and rows from the old cluster must not dress up as the new.
     */
    contextKey: string;
    /**
     * Filter dimensions beyond the search text (the severity list), flattened
     * to a string. The offset resets when it changes: page 3 of one filter is
     * not a page of another.
     */
    scope?: string;
    /** Build the request URL for one page. Read fresh on every fetch. */
    makeUrl: (query: PagedQuery) => string;
    /** Error message when a failure carries no message of its own. */
    errorFallback: string;
    /**
     * The search the page opened with (`?search=` in the URL, from the
     * Dashboard's search box). Seeds both the box and the committed query, so
     * the first fetch is already the searched one rather than the unfiltered
     * page followed by a debounce.
     */
    initialSearch?: string;
};

/**
 * Server-side search + offset paging as one machine: a debounced search box
 * value, a scope-carrying offset, and latest-wins fetching where stale data
 * stays on screen (dimmed via `isStale`) instead of blanking on every
 * keystroke. Extracted verbatim from the cluster Packages and Vulnerabilities
 * tabs, which had grown the same ~85 lines independently.
 *
 * The fetch result carries the key it was for — a key change reads as "not
 * loaded yet" without a synchronous setState in the effect body. A failed
 * load keeps the table it already drew: the rows on screen are still true as
 * of the last successful query, and the caller's banner says so.
 */
export function usePagedResource<T>({
    contextKey,
    scope = '',
    makeUrl,
    errorFallback,
    initialSearch = '',
}: UsePagedResourceOptions) {
    const [searchInput, setSearchInput] = useState(initialSearch);
    const [search, setSearch] = useState(initialSearch.trim());

    useEffect(() => {
        const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [searchInput]);

    /* The offset carries the scope it belongs to, so a scope change reads as
       offset 0 without a synchronous setState anywhere. */
    const pageScope = `${scope}|${search}`;
    const [paged, setPaged] = useState({ scope: '', offset: 0 });
    const offset = paged.scope === pageScope ? paged.offset : 0;
    const setOffset = useCallback((next: number) => setPaged({ scope: pageScope, offset: next }), [pageScope]);

    /* `|` is safe as a key separator: the context key is a UUID, the offset is
       a number, scope values come from fixed vocabularies, and the free-text
       search is the tail. */
    const key = `${contextKey}|${offset}|${pageScope}`;

    const [fetched, setFetched] = useState<{
        key: string;
        contextKey: string;
        data: T | null;
        error: string | null;
    } | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);

    /* In a ref so callers can pass an inline closure without retriggering the
       fetch effect — the effect keys on what the closure reads, via `key`. */
    const makeUrlRef = useRef(makeUrl);
    useEffect(() => {
        makeUrlRef.current = makeUrl;
    });

    const load = useCallback(
        (signal?: AbortSignal) => {
            return fetch(makeUrlRef.current({ limit: PAGE_SIZE, offset, search }), { signal })
                .then(async (r) => {
                    /* The session is gone and a reload is on its way: leave
                       the table as it is (see `reloadIfSessionLost`). */
                    if (r.status === 401 && (await reloadIfSessionLost())) return null;
                    if (!r.ok) throw new Error(`HTTP ${r.status}`);
                    return r.json() as Promise<T>;
                })
                .then((data) => {
                    if (data !== null) setFetched({ key, contextKey, data, error: null });
                })
                .catch((err) => {
                    if (err instanceof DOMException && err.name === 'AbortError') return;
                    const error = err instanceof Error ? err.message : errorFallback;
                    /* A failed load keeps the table it already drew. */
                    setFetched((prev) => ({
                        key,
                        contextKey,
                        data: prev?.contextKey === contextKey ? prev.data : null,
                        error,
                    }));
                });
        },
        [contextKey, key, offset, search, errorFallback],
    );

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const handleRefresh = useCallback(() => {
        setIsRefreshing(true);
        load().finally(() => setIsRefreshing(false));
    }, [load]);

    /* Data from another context never shows; data from another page/search of
       *this* context stays up, dimmed, while its replacement loads — a search
       that blanks the table on every keystroke reads as flicker. */
    const current = fetched?.contextKey === contextKey ? fetched : null;
    const data = current?.data ?? null;
    const error = current?.error ?? null;
    const isStale = current !== null && current.key !== key;

    return {
        /** The raw input box value; bind it to `<SearchInput>`. */
        searchInput,
        setSearchInput,
        /** The committed search the shown query used. */
        search,
        setOffset,
        data,
        error,
        isStale,
        isRefreshing,
        /** False until the first response for this context lands. */
        isLoaded: current !== null,
        handleRefresh,
    };
}
