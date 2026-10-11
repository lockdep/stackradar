'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * `?cluster=` and `?namespace=` — the scope of a findings list, held in the
 * URL like its other filters (`useControlFilter`): a scoped list is a link
 * people paste. The same two parameters `/containers` reads
 * (`useContainersView`), so a scoped link means the same thing on both: the
 * cluster is an id, the namespace a *name*, so one value can span clusters.
 * Absent means all of them.
 *
 * Needs a Suspense boundary above it, like every `useSearchParams` reader.
 */
export function useScopeFilter(): {
    cluster: string | null;
    namespace: string | null;
    /**
     * A different cluster drops the namespace — the name usually does not
     * exist there — unless the caller, who can see the options, says it does.
     */
    setCluster: (id: string | null, options?: { keepNamespace?: boolean }) => void;
    setNamespace: (name: string | null) => void;
} {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const cluster = searchParams.get('cluster') || null;
    const namespace = searchParams.get('namespace') || null;

    const write = useCallback(
        (mutate: (params: URLSearchParams) => void) => {
            const params = new URLSearchParams(searchParams.toString());
            mutate(params);
            const query = params.toString();
            router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
        },
        [pathname, router, searchParams],
    );

    const setCluster = useCallback(
        (id: string | null, { keepNamespace = false }: { keepNamespace?: boolean } = {}) =>
            write((params) => {
                if (id) params.set('cluster', id);
                else params.delete('cluster');
                if (id !== cluster && !keepNamespace) params.delete('namespace');
            }),
        [cluster, write],
    );

    const setNamespace = useCallback(
        (name: string | null) =>
            write((params) => {
                if (name) params.set('namespace', name);
                else params.delete('namespace');
            }),
        [write],
    );

    return { cluster, namespace, setCluster, setNamespace };
}
