'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { Cluster } from '@/types/cluster'

interface ClusterContextValue {
    cluster: Cluster
    /**
     * Settings renames the cluster; the header and breadcrumb live in the
     * layout above it, so the name has to travel back up.
     */
    setClusterName: (name: string) => void
    /**
     * Re-read the cluster record (heartbeat, versions). The Overview tab's
     * refresh button calls it alongside its own reloads, so one click brings
     * the header up to date too.
     */
    refetchCluster: () => Promise<void>
}

const ClusterContext = createContext<ClusterContextValue | null>(null)

/** Provided by `clusters/[id]/(tabs)/layout.tsx`, which owns the cluster fetch. */
export function ClusterProvider({
    value,
    children,
}: {
    value: ClusterContextValue
    children: ReactNode
}) {
    return <ClusterContext.Provider value={value}>{children}</ClusterContext.Provider>
}

export function useCluster(): ClusterContextValue {
    const context = useContext(ClusterContext)
    if (!context) {
        throw new Error('useCluster must be used inside a cluster tab route')
    }
    return context
}
