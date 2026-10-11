'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePollWhile } from '@/hooks';
import { useContainers } from '@/components/containers';
import type { Container } from '@/types/container';

interface ClusterContainersContextValue {
    /** Every running container in this cluster. */
    containers: Container[];
    error: string | null;
    isLoading: boolean;
    isRefreshing: boolean;
    lastUpdated: Date | null;
    handleRefresh: () => Promise<void>;
}

const ClusterContainersContext = createContext<ClusterContainersContextValue | null>(null);

/** How often to re-check for containers while a cluster still has none. */
const WAITING_POLL_MS = 15_000;

/**
 * Holds the container list for the Overview and Containers tabs, so switching
 * between them doesn't refetch.
 *
 * It sits in the layout, but it deliberately does **not** gate its children on
 * `isLoading`/`error` — Settings is a sibling that needs none of this data, and
 * gating here would take the rename and API-key controls down with a failed
 * containers request. Each consuming page renders its own loading and error
 * states; Settings simply never calls `useClusterContainers`.
 */
export function ClusterContainersProvider({ clusterId, children }: { clusterId: string; children: ReactNode }) {
    const { containers: allContainers, error, isLoading, isRefreshing, lastUpdated, handleRefresh } = useContainers();

    // `useContainers` returns every container in the org and we narrow in the
    // browser. `GET /api/containers?clusterId=` exists and is the obvious shape
    // now that each route owns its data.
    const containers = useMemo(
        () => allContainers.filter((w) => w.clusterId === clusterId),
        [allContainers, clusterId],
    );

    /* A cluster with no containers is almost always a cluster whose scanner is
       still starting up — the first inventory report lands within seconds of
       `helm install`, the first SBOM a minute or two later. Polling until
       something arrives means the empty state resolves itself instead of asking
       the user to hit refresh. The first container to land falsifies the
       condition, so the interval stops itself. */
    usePollWhile(containers.length === 0, handleRefresh, WAITING_POLL_MS);

    const value = useMemo(
        () => ({ containers, error, isLoading, isRefreshing, lastUpdated, handleRefresh }),
        [containers, error, isLoading, isRefreshing, lastUpdated, handleRefresh],
    );

    return <ClusterContainersContext.Provider value={value}>{children}</ClusterContainersContext.Provider>;
}

export function useClusterContainers(): ClusterContainersContextValue {
    const context = useContext(ClusterContainersContext);
    if (!context) {
        throw new Error('useClusterContainers must be used inside a cluster tab route');
    }
    return context;
}
