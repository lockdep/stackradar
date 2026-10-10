'use client'

import { useResource } from '@/hooks'

export interface ChartRepositoryRow {
    id: string
    url: string
    source: 'observed' | 'manual' | 'artifact-hub-confirmed' | 'artifact-hub-matched'
    enabled: boolean
    hasCredentials: boolean
    lastFetchedAt: string | null
    lastFetchError: string | null
}

type ChartRepositoriesData = {
    repositories: ChartRepositoryRow[]
    unknownCharts: string[]
}

/** The Chart repositories tab's data: the registered repositories plus the charts with no known repository. */
export function useChartRepositories() {
    const { data, error, refetch } = useResource<ChartRepositoriesData>('/api/chart-repositories', {
        select: body => {
            const out = body as { repositories?: ChartRepositoryRow[]; unknownCharts?: string[] }
            return {
                repositories: out.repositories ?? [],
                unknownCharts: out.unknownCharts ?? [],
            }
        },
        responseError: (res, body) =>
            (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`,
        fallbackError: 'Failed to load',
    })

    return {
        repositories: data?.repositories ?? null,
        unknownCharts: data?.unknownCharts ?? [],
        error,
        refresh: refetch,
    }
}
