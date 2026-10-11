'use client';

import { useResource } from '@/hooks';
import { ApiError, apiFetch } from '@/lib/api-client';
import type { Cluster } from '@/types/cluster';

/** A cluster and the scanner key created with it, shown only once. */
export type CreatedCluster = { cluster: Cluster; apiKey: string };

export class PlanLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlanLimitError';
    }
}

/**
 * `POST /api/clusters`: creates the cluster and returns it together with the
 * scanner API key the server minted for it — the one and only time that key
 * is readable. Every caller has to do something with it in the same breath.
 *
 * Standalone so the onboarding screen, which creates a cluster from an effect
 * rather than a click, can call it with a stable identity.
 */
export async function createClusterRequest(input: { name: string; description?: string }): Promise<CreatedCluster> {
    try {
        const data = await apiFetch<{ cluster: Cluster; apiKey: string }>('/api/clusters', {
            method: 'POST',
            json: input,
        });
        return { cluster: data.cluster, apiKey: data.apiKey };
    } catch (err) {
        // The server tags plan-limit rejections with a machine-readable
        // code; matching on the bare 403 would render any future
        // authorization failure as an upgrade prompt.
        if (err instanceof ApiError && (err.body as { code?: unknown } | undefined)?.code === 'PLAN_LIMIT_EXCEEDED') {
            throw new PlanLimitError(err.message);
        }
        throw err;
    }
}

export function useClusters() {
    const {
        data,
        error,
        isLoading,
        isRefreshing,
        lastUpdated,
        refetch: handleRefresh,
    } = useResource<Cluster[]>('/api/clusters', {
        select: (body) => {
            const clusters = (body as { clusters?: unknown }).clusters;
            return Array.isArray(clusters) ? (clusters as Cluster[]) : [];
        },
        responseError: (_res, body) => (body as { error?: string }).error || 'Failed to fetch clusters',
        fallbackError: 'Failed to fetch clusters',
        // Scanner health ages in the background; re-read it when the tab is looked at again.
        revalidateOnFocus: true,
    });

    /** `createClusterRequest`, then a refresh of the list this hook owns. */
    const createCluster = async (input: { name: string; description?: string }): Promise<CreatedCluster> => {
        const created = await createClusterRequest(input);
        void handleRefresh();
        return created;
    };

    const deleteCluster = async (clusterId: string): Promise<void> => {
        await apiFetch(`/api/clusters/${clusterId}`, { method: 'DELETE' });
        void handleRefresh();
    };

    return {
        clusters: data ?? [],
        error,
        isLoading,
        isRefreshing,
        lastUpdated,
        handleRefresh,
        createCluster,
        deleteCluster,
    };
}
