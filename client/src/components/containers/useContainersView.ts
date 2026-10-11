'use client';

import { CONTROL_FILTER_PARAM, isControlFilter, type ControlFilter } from '@/lib/image-control';
import { useCallback, useMemo } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SortColumn, SortDirection, ContainerFilter } from '@/types/container';

/**
 * The ranking and the filters — held in the URL rather than in React state.
 *
 * "Here is the row I mean" is a link people want to paste, and a triaged view is
 * exactly the thing worth sending: the sort and the filters together are what
 * narrowed forty-seven containers down to the one that needs doing. None of
 * that survives a copied URL if it lives in `useState`.
 *
 * The search box deliberately stays out. It is a transient narrowing rather than
 * a view — and syncing it would put a router write on every keystroke, on a page
 * that already regroups the whole list on each one.
 *
 * Defaults are **absent** from the query string, not spelled out in it. A fresh
 * tab has a clean URL, and every parameter that is present is one somebody chose.
 *
 * Two callers: the cluster tab (no options — name-ascending, no scope) and the
 * org-wide `/containers` page, which opens worst-first and scopes by cluster
 * and namespace. Both read the same parameters so a URL means the same thing
 * on either page.
 */

const SORT_COLUMNS: SortColumn[] = ['name', 'scannedAt', 'onImage', 'severity', 'risk', 'firstSeen', 'built'];
const FILTERS: ContainerFilter[] = ['unscanned'];

/**
 * Which way a column points the first time it is clicked.
 *
 * Not uniformly ascending. The first useful answer from "sort by severity" is
 * the worst row, and from "sort by scanned" the freshest — an ascending first
 * click on severity would open with the unscanned rows and the clean ones, which
 * is the exact reading this whole surface exists to prevent.
 */
const FIRST_DIRECTION: Record<SortColumn, SortDirection> = {
    name: 'asc',
    scannedAt: 'desc',
    // Longest-running first: the digest nobody has redeployed is the question.
    onImage: 'desc',
    severity: 'desc',
    risk: 'desc',
    // Newest arrival first: what just showed up in the cluster.
    firstSeen: 'desc',
    // Oldest build first: the image nobody has rebuilt is the question.
    built: 'asc',
};

export type ContainersViewOptions = {
    /**
     * The order the page opens in when `?sort=` is absent. The column's
     * `FIRST_DIRECTION` is the default direction, and a click sequence that
     * lands back on that pair clears both params — the default stays absent
     * from the URL. Unset means name ascending with `sortColumn: null`, which
     * is what the cluster tab wants.
     */
    defaultSort?: SortColumn;
};

export type ContainersView = {
    sortColumn: SortColumn | null;
    sortDirection: SortDirection;
    filters: Set<ContainerFilter>;
    /** `?cluster=` — a cluster id, or null for every cluster. */
    clusterId: string | null;
    /** `?namespace=` — a namespace *name*, so one value can span clusters. */
    namespace: string | null;
    /** `?registry=` — a registry host; the `/images` list's scope. */
    registry: string | null;
    /** `?control=` — "Yours / Third-party / All"; absent means All. */
    control: ControlFilter;
    setControl: (next: ControlFilter) => void;
    /** Same column flips direction; a new column starts at `FIRST_DIRECTION`. */
    toggleSort: (column: SortColumn) => void;
    toggleFilter: (filter: ContainerFilter) => void;
    /**
     * Scope to one cluster. A different cluster drops the namespace param —
     * the name usually does not exist there — unless the caller, who can see
     * the rows, says it still does.
     */
    setCluster: (id: string | null, options?: { keepNamespace?: boolean }) => void;
    setNamespace: (name: string | null) => void;
    setRegistry: (host: string | null) => void;
    /** Clears `filter`, `cluster`, `namespace` and `registry`; the sort is not a filter and stays. */
    clearFilters: () => void;
};

export function useContainersView({ defaultSort }: ContainersViewOptions = {}): ContainersView {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    /* A hand-edited or stale URL degrades to the default rather than throwing or
       rendering an empty list — every value is checked against the union it
       claims to be a member of. */
    const explicitColumn = pick(searchParams.get('sort'), SORT_COLUMNS);
    const sortColumn = explicitColumn ?? defaultSort ?? null;
    const sortDirection: SortDirection = explicitColumn
        ? searchParams.get('dir') === 'desc'
            ? 'desc'
            : 'asc'
        : defaultSort
          ? FIRST_DIRECTION[defaultSort]
          : 'asc';

    const filterParam = searchParams.get('filter');
    const filters = useMemo(
        () =>
            new Set(
                (filterParam ?? '').split(',').flatMap((f) => {
                    const valid = pick(f, FILTERS);
                    return valid ? [valid] : [];
                }),
            ),
        [filterParam],
    );

    const clusterId = searchParams.get('cluster') || null;
    const namespace = searchParams.get('namespace') || null;
    const registry = searchParams.get('registry') || null;
    const controlParam = searchParams.get(CONTROL_FILTER_PARAM);
    const control: ControlFilter = isControlFilter(controlParam) ? controlParam : 'all';

    /* `replace`, not `push`: changing a sort is refining one view, not
       navigating to another, and a back button that walks a user through nine
       sort clicks to leave the page is a worse trade than losing them. */
    const write = useCallback(
        (mutate: (params: URLSearchParams) => void) => {
            const params = new URLSearchParams(searchParams.toString());
            mutate(params);
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const toggleSort = useCallback(
        (column: SortColumn) =>
            write((params) => {
                const flipped = sortColumn === column && sortDirection === FIRST_DIRECTION[column];
                const next = flipped ? (FIRST_DIRECTION[column] === 'asc' ? 'desc' : 'asc') : FIRST_DIRECTION[column];
                if (defaultSort && column === defaultSort && next === FIRST_DIRECTION[defaultSort]) {
                    // Back on the page's own default: say nothing rather than
                    // spell it out, so a fresh tab and a round trip look alike.
                    params.delete('sort');
                    params.delete('dir');
                    return;
                }
                params.set('sort', column);
                if (next === 'asc') params.delete('dir');
                else params.set('dir', next);
            }),
        [defaultSort, sortColumn, sortDirection, write],
    );

    const toggleFilter = useCallback(
        (filter: ContainerFilter) =>
            write((params) => {
                const next = new Set(filters);
                if (next.has(filter)) next.delete(filter);
                else next.add(filter);
                // Written in the declaration order rather than the click order, so
                // the same view is always the same link.
                const value = FILTERS.filter((f) => next.has(f)).join(',');
                if (value) params.set('filter', value);
                else params.delete('filter');
            }),
        [filters, write],
    );

    const setCluster = useCallback(
        (id: string | null, { keepNamespace = false }: { keepNamespace?: boolean } = {}) =>
            write((params) => {
                if (id) params.set('cluster', id);
                else params.delete('cluster');
                if (id !== clusterId && !keepNamespace) params.delete('namespace');
            }),
        [clusterId, write],
    );

    const setNamespace = useCallback(
        (name: string | null) =>
            write((params) => {
                if (name) params.set('namespace', name);
                else params.delete('namespace');
            }),
        [write],
    );

    const setRegistry = useCallback(
        (host: string | null) =>
            write((params) => {
                if (host) params.set('registry', host);
                else params.delete('registry');
            }),
        [write],
    );

    const setControl = useCallback(
        (next: ControlFilter) =>
            write((params) => {
                if (next === 'all') params.delete(CONTROL_FILTER_PARAM);
                else params.set(CONTROL_FILTER_PARAM, next);
            }),
        [write],
    );

    const clearFilters = useCallback(
        () =>
            write((params) => {
                params.delete('filter');
                params.delete('cluster');
                params.delete('namespace');
                params.delete('registry');
                params.delete(CONTROL_FILTER_PARAM);
            }),
        [write],
    );

    return {
        sortColumn,
        sortDirection,
        filters,
        clusterId,
        namespace,
        registry,
        control,
        setControl,
        toggleSort,
        toggleFilter,
        setCluster,
        setNamespace,
        setRegistry,
        clearFilters,
    };
}

function pick<T extends string>(value: string | null, allowed: T[]): T | null {
    return value !== null && (allowed as string[]).includes(value) ? (value as T) : null;
}
