'use client';

import { useMemo } from 'react';
import { useResource } from '@/hooks';
import type { Container } from '@/types/container';
import { getTotalVulnerabilities } from '@/utils/containerUtils';

/**
 * Every running container in the org.
 *
 * There is no delete. Containers are discovered by the scanner's inventory
 * report and disappear when they stop running, so a delete button would either
 * lie (the row comes back on the next report) or delete the wrong thing (the
 * image, which other containers may still be running).
 */
export function useContainers() {
    const {
        data,
        error,
        isLoading,
        isRefreshing,
        lastUpdated,
        refetch: handleRefresh,
    } = useResource<Container[]>('/api/containers', {
        responseError: (_res, body) => (body as { error?: string }).error || 'Failed to fetch containers',
        fallbackError: 'Failed to fetch containers',
        /* Containers change when a scanner reports, which is minutes apart at best —
           so refetch when the user comes back to the tab rather than on a timer. */
        revalidateOnFocus: true,
    });

    const containers = useMemo(() => data ?? [], [data]);

    const totalVulnerabilities = useMemo(() => getTotalVulnerabilities(containers), [containers]);

    return {
        containers,
        error,
        isLoading,
        isRefreshing,
        lastUpdated,
        totalVulnerabilities,
        handleRefresh,
    };
}
