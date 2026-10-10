'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ContainerDetailView } from '@/views'
import { LoadingBlock } from '@/components/ui'
import type { Container } from '@/types/container'
import type { Cluster } from '@/types/cluster'

export default function ContainerDetailPage() {
    const { id, containerId } = useParams<{ id: string; containerId: string }>()
    const router = useRouter()

    const [container, setContainer] = useState<Container | null>(null)
    const [cluster, setCluster] = useState<Cluster | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        /* One request per resource, no parent lookup. The namespace, container
           and release names all ride on the container row now — under the old
           tree they lived on a `parentId` row that had to be fetched
           separately. */
        Promise.all([
            fetch(`/api/containers/${containerId}`).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json() as Promise<Container>
            }),
            fetch(`/api/clusters/${id}`).then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json() as Promise<{ cluster: Cluster }>
            }),
        ])
            .then(([workloadData, clusterData]) => {
                setContainer(workloadData)
                setCluster(clusterData.cluster)
                setLoading(false)
            })
            .catch(err => {
                setError(err instanceof Error ? err.message : 'Failed to load container')
                setLoading(false)
            })
    }, [id, containerId])

    if (loading) {
        return (
            <LoadingBlock />
        )
    }

    if (error || !container || !cluster) {
        return (
            <div className="flex items-center justify-center py-24">
                <div className="text-center">
                    <p className="text-sm font-medium text-ink">Failed to load container</p>
                    <p className="mt-1 text-sm text-ink-muted">{error}</p>
                    <button
                        onClick={() => router.push(`/clusters/${id}`)}
                        className="mt-4 cursor-pointer text-sm text-success hover:underline"
                    >
                        Back to Cluster
                    </button>
                </div>
            </div>
        )
    }

    return <ContainerDetailView container={container} cluster={cluster} />
}
