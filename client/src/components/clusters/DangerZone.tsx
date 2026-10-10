'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { TriangleAlert } from 'lucide-react'
import { useRuntimeConfig } from '@/components/providers'
import { useCluster } from './ClusterContext'

/**
 * The "Danger zone" settings section: type-the-name-to-confirm cluster
 * deletion. Absent in the live demo — the settings page is already behind
 * `isAdminOrOwner`, which the demo reports false, but a delete button is
 * the one control worth a second lock.
 */
export function DangerZone() {
    const router = useRouter()
    const { cluster } = useCluster()
    const { demoMode } = useRuntimeConfig()

    const [showDeleteClusterConfirm, setShowDeleteClusterConfirm] = useState(false)
    const [deleteClusterConfirmText, setDeleteClusterConfirmText] = useState('')
    const [isDeletingCluster, setIsDeletingCluster] = useState(false)
    const [deleteClusterError, setDeleteClusterError] = useState<string | null>(null)

    const handleConfirmDeleteCluster = async () => {
        if (deleteClusterConfirmText !== cluster.name) return
        setIsDeletingCluster(true)
        setDeleteClusterError(null)
        try {
            const response = await fetch(`/api/clusters/${cluster.id}`, { method: 'DELETE' })
            const data = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(data.error || 'Failed to delete cluster')
            router.push('/clusters')
        } catch (err) {
            setDeleteClusterError(err instanceof Error ? err.message : 'Failed to delete cluster')
            setIsDeletingCluster(false)
        }
    }

    if (demoMode) return null

    return (
        <section className="rounded-md border border-danger-muted bg-danger-subtle">
            <div className="px-5 py-4 border-b border-danger-muted">
                <h3 className="text-base font-semibold text-danger">Danger zone</h3>
            </div>
            <div className="px-5 py-4">
                {!showDeleteClusterConfirm ? (
                    <div className="flex items-center justify-between">
                        <div>
                            <p className="text-sm font-medium text-ink">Delete this cluster</p>
                            <p className="text-sm text-ink-muted">
                                Permanently delete this cluster and all of its containers, SBOMs, and vulnerability data.
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => setShowDeleteClusterConfirm(true)}
                            className="ml-4 inline-flex items-center rounded-md bg-danger-emphasis px-3 py-2 text-sm font-semibold text-on-emphasis shadow-resting hover:bg-danger-emphasis-hover cursor-pointer transition-colors whitespace-nowrap"
                        >
                            Delete cluster
                        </button>
                    </div>
                ) : (
                    <div>
                        <div className="flex items-start gap-3 mb-4">
                            <TriangleAlert className="size-5 text-danger shrink-0 mt-0.5" />
                            <div>
                                <p className="text-sm font-medium text-danger">This action cannot be undone.</p>
                                <p className="mt-1 text-sm text-ink-secondary">
                                    Type <span className="font-semibold text-ink">{cluster.name}</span> to confirm deletion.
                                </p>
                            </div>
                        </div>
                        <input
                            type="text"
                            value={deleteClusterConfirmText}
                            onChange={(e) => {
                                setDeleteClusterConfirmText(e.target.value)
                                setDeleteClusterError(null)
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && deleteClusterConfirmText === cluster.name) handleConfirmDeleteCluster()
                                if (e.key === 'Escape') {
                                    setShowDeleteClusterConfirm(false)
                                    setDeleteClusterConfirmText('')
                                }
                            }}
                            placeholder={cluster.name}
                            className="block w-full rounded-md border border-danger-muted px-3 py-2 text-sm text-ink placeholder:text-ink-faint/70 focus:border-danger-muted focus:ring-2 focus:ring-danger-muted outline-none"
                        />
                        {deleteClusterError && (
                            <p className="mt-2 text-sm text-danger">{deleteClusterError}</p>
                        )}
                        <div className="mt-3 flex items-center gap-3">
                            <button
                                type="button"
                                onClick={handleConfirmDeleteCluster}
                                disabled={deleteClusterConfirmText !== cluster.name || isDeletingCluster}
                                className="inline-flex items-center gap-1.5 rounded-md bg-danger-emphasis px-3 py-2 text-sm font-semibold text-on-emphasis shadow-resting hover:bg-danger-emphasis-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                            >
                                {isDeletingCluster ? (
                                    <svg className="animate-spin size-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                    </svg>
                                ) : null}
                                {isDeletingCluster ? 'Deleting...' : 'I understand, delete this cluster'}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowDeleteClusterConfirm(false)
                                    setDeleteClusterConfirmText('')
                                    setDeleteClusterError(null)
                                }}
                                className="rounded-md px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-hover cursor-pointer transition-colors"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </section>
    )
}
