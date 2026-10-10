'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ReleaseDetailView } from '@/views'
import type { ReleaseDetail } from '@/views/ReleaseDetailView'
import { LoadingBlock } from '@/components/ui'

/**
 * A release page, but not a sidebar section.
 *
 * Release is the third lens over the same workload rows — alongside namespace
 * (the folder view) and image (the remediation view). It gets a route because a
 * chart is a thing you link to and come back to; it does not get a nav entry,
 * because it is a way of looking at the workloads list rather than a separate
 * part of the product.
 */
export default function ReleaseDetailPage() {
    const { id } = useParams<{ id: string }>()
    const router = useRouter()

    const [detail, setDetail] = useState<ReleaseDetail | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetch(`/api/releases/${id}`)
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`)
                return r.json() as Promise<ReleaseDetail>
            })
            .then(setDetail)
            .catch(err => setError(err instanceof Error ? err.message : 'Failed to load release'))
            .finally(() => setLoading(false))
    }, [id])

    if (loading) {
        return (
            <LoadingBlock />
        )
    }

    if (error || !detail) {
        return (
            <div className="flex items-center justify-center py-24">
                <div className="text-center">
                    <p className="text-sm font-medium text-ink">Failed to load release</p>
                    <p className="mt-1 text-sm text-ink-muted">{error}</p>
                    <button
                        onClick={() => router.push('/clusters')}
                        className="mt-4 cursor-pointer text-sm text-success hover:underline"
                    >
                        Back to Clusters
                    </button>
                </div>
            </div>
        )
    }

    return <ReleaseDetailView detail={detail} />
}
