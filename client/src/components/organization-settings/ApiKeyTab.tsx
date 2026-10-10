'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Check, ClipboardCopy, Eye, EyeOff, Plus, RefreshCw, Trash2 } from 'lucide-react'
import {
    Button,
    ConfirmDialog,
    LoadingBlock,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui'
import { useRuntimeConfig } from '@/components/providers'
import { EntityIcon } from '@/components/ui/EntityIcon'
import { ScannerDot, getScannerHealth } from '@/components/clusters/ScannerDot'
import { rotateClusterApiKey } from '@/components/clusters/rotateClusterApiKey'
import { useApiKeyReveal } from '@/components/clusters/useApiKeyReveal'
import { formatTimeAgo } from '@/utils/formatters'

/** One row of `GET /api/clusters/api-keys`. */
interface ClusterKeyRow {
    id: string
    name: string
    scannerVersion: string | null
    scannerLastSeenAt: string | null
    key: {
        /** Masked: the prefix and dots. */
        apiKey: string
        createdAt: string
        lastUsedAt: string | null
        /** Whether the server can show the plaintext again — false for keys minted before the vault. */
        revealable: boolean
        lastRevealedAt: string | null
    } | null
}

interface ApiKeyTabProps {
    orgId?: string
    currentRole: string
}

function useCopy() {
    const [copied, setCopied] = useState(false)
    const copy = useCallback(async (text: string) => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            /* clipboard unavailable — the text is still selectable */
        }
    }, [])
    return { copied, copy }
}

/**
 * One cluster's row. Owns everything that happens to its key — the reveal
 * (from the vault, hides itself after a minute), a freshly minted key (shown
 * once, stays until the row re-renders from a refetch or the reader moves
 * on), and the rotate/revoke confirmations — and tells the tab to refetch
 * when the row's facts changed.
 */
function ApiKeyRow({
    cluster,
    canManage,
    onChanged,
    onError,
}: {
    cluster: ClusterKeyRow
    canManage: boolean
    onChanged: () => Promise<void>
    onError: (message: string | null) => void
}) {
    const revealed = useApiKeyReveal(cluster.id)
    const [mintedKey, setMintedKey] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null)
    const [isBusy, setIsBusy] = useState(false)
    const { copied, copy } = useCopy()

    /* A minted key outranks a revealed one: it is the only copy the reader
       will get without a reveal, and it is what the rotate just replaced
       the revealed key with. */
    const shownKey = mintedKey ?? revealed.apiKey
    const health = getScannerHealth(cluster.scannerLastSeenAt)

    const handleGenerate = async () => {
        setIsBusy(true)
        onError(null)
        try {
            const key = await rotateClusterApiKey(cluster.id)
            revealed.hide()
            setMintedKey(key)
            await onChanged()
        } catch (err) {
            onError(err instanceof Error ? err.message : 'Failed to generate API key')
        } finally {
            setIsBusy(false)
            setConfirm(null)
        }
    }

    const handleRevoke = async () => {
        setIsBusy(true)
        onError(null)
        try {
            const response = await fetch(`/api/clusters/${cluster.id}/api-key`, { method: 'DELETE' })
            if (!response.ok) {
                const data = await response.json().catch(() => ({}))
                throw new Error(data.error || 'Failed to revoke API key')
            }
            revealed.hide()
            setMintedKey(null)
            await onChanged()
        } catch (err) {
            onError(err instanceof Error ? err.message : 'Failed to revoke API key')
        } finally {
            setIsBusy(false)
            setConfirm(null)
        }
    }

    return (
        <>
            <TableRow hoverable>
                <TableCell>
                    <div className="flex items-center gap-2 min-w-0">
                        <EntityIcon kind="cluster" className="size-4 shrink-0 text-ink-faint" />
                        <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-ink sm:text-sm">{cluster.name}</p>
                            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-muted">
                                <ScannerDot health={health} />
                                {cluster.scannerLastSeenAt
                                    ? <>Scanner seen {formatTimeAgo(cluster.scannerLastSeenAt)}{cluster.scannerVersion && ` · ${cluster.scannerVersion}`}</>
                                    : 'Scanner not connected'}
                            </p>
                        </div>
                    </div>
                </TableCell>

                <TableCell>
                    {cluster.key ? (
                        <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                                {/* ph-no-capture: a shown key stays out of session replay */}
                                <code className={`ph-no-capture font-mono text-xs text-ink ${shownKey ? 'break-all' : 'whitespace-nowrap'}`}>
                                    {shownKey ?? cluster.key.apiKey}
                                </code>
                                {shownKey && (
                                    <button
                                        type="button"
                                        onClick={() => copy(shownKey)}
                                        className="shrink-0 rounded-md p-1 text-ink-faint hover:bg-surface-hover hover:text-ink transition-colors cursor-pointer"
                                        title="Copy key"
                                    >
                                        {copied ? <Check className="size-3.5 text-success" /> : <ClipboardCopy className="size-3.5" />}
                                    </button>
                                )}
                            </div>
                            {/* The one line that says what the shown key is: minted
                                keys are gone when the row is, revealed ones on a
                                timer, and a pre-vault key can only be rotated. */}
                            {mintedKey ? (
                                <p className="mt-0.5 text-xs text-attention">Shown once — copy it now.</p>
                            ) : revealed.apiKey ? (
                                <p className="mt-0.5 text-xs text-ink-muted">Reveal recorded · hides in a minute</p>
                            ) : revealed.error ? (
                                <p className="mt-0.5 text-xs text-danger">{revealed.error.message}</p>
                            ) : !cluster.key.revealable && canManage ? (
                                <p className="mt-0.5 text-xs text-ink-muted">Rotate to get a key that can be shown again</p>
                            ) : cluster.key.lastRevealedAt ? (
                                <p className="mt-0.5 text-xs text-ink-muted">Last revealed {formatTimeAgo(cluster.key.lastRevealedAt)}</p>
                            ) : null}
                        </div>
                    ) : (
                        <span className="text-xs text-ink-muted sm:text-sm">No key</span>
                    )}
                </TableCell>

                <TableCell hideBelow="md" className="whitespace-nowrap text-ink-muted">
                    {cluster.key ? formatTimeAgo(cluster.key.createdAt) : '—'}
                </TableCell>

                <TableCell hideBelow="lg" className="whitespace-nowrap text-ink-muted">
                    {cluster.key ? (cluster.key.lastUsedAt ? formatTimeAgo(cluster.key.lastUsedAt) : 'Never') : '—'}
                </TableCell>

                {canManage && (
                    <TableCell align="end" className="whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                            {cluster.key ? (
                                <>
                                    {cluster.key.revealable && !mintedKey && (
                                        revealed.apiKey ? (
                                            <Button variant="invisible" size="sm" onClick={revealed.hide} title="Hide the key">
                                                <EyeOff className="size-3.5" />
                                                Hide
                                            </Button>
                                        ) : (
                                            <Button
                                                variant="invisible"
                                                size="sm"
                                                onClick={revealed.reveal}
                                                loading={revealed.isRevealing}
                                                disabled={isBusy}
                                                title="Show the current key — every reveal is recorded"
                                            >
                                                {!revealed.isRevealing && <Eye className="size-3.5" />}
                                                Reveal
                                            </Button>
                                        )
                                    )}
                                    <Button
                                        variant="invisible"
                                        size="sm"
                                        onClick={() => setConfirm('rotate')}
                                        disabled={isBusy}
                                        title="Replace the key — the current one stops working immediately"
                                    >
                                        <RefreshCw className="size-3.5" />
                                        Rotate
                                    </Button>
                                    <button
                                        type="button"
                                        onClick={() => setConfirm('revoke')}
                                        disabled={isBusy}
                                        className="rounded-md p-1.5 text-ink-faint hover:bg-danger-subtle hover:text-danger transition-colors disabled:opacity-50 cursor-pointer"
                                        title="Revoke the key"
                                    >
                                        <Trash2 className="size-4" />
                                        <span className="sr-only">Revoke</span>
                                    </button>
                                </>
                            ) : (
                                <Button variant="primary" size="sm" onClick={handleGenerate} loading={isBusy}>
                                    {!isBusy && <Plus className="size-3.5" />}
                                    Generate key
                                </Button>
                            )}
                        </div>
                    </TableCell>
                )}
            </TableRow>

            <ConfirmDialog
                isOpen={confirm === 'rotate'}
                onClose={() => setConfirm(null)}
                onConfirm={handleGenerate}
                title={`Rotate the key for ${cluster.name}`}
                message="The current key stops working immediately. The scanner keeps failing to report until its Secret carries the new key."
                confirmText="Rotate key"
                isDestructive
                isLoading={isBusy}
            />
            <ConfirmDialog
                isOpen={confirm === 'revoke'}
                onClose={() => setConfirm(null)}
                onConfirm={handleRevoke}
                title={`Revoke the key for ${cluster.name}`}
                message="The scanner immediately loses the ability to upload SBOMs. Generate a new key to reconnect it."
                confirmText="Revoke key"
                isDestructive
                isLoading={isBusy}
            />
        </>
    )
}

export function ApiKeyTab({ currentRole }: ApiKeyTabProps) {
    const { demoMode } = useRuntimeConfig()
    const [clusters, setClusters] = useState<ClusterKeyRow[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    /* Every key action is admin/owner-only on the server, and the demo org
       refuses them all — so the actions column is not drawn at all rather
       than drawn as buttons that 403. */
    const canManage = (currentRole === 'owner' || currentRole === 'admin') && !demoMode

    const fetchClusters = useCallback(async ({ silent = false } = {}) => {
        if (!silent) setIsLoading(true)
        try {
            const response = await fetch('/api/clusters/api-keys')
            if (!response.ok) throw new Error('Failed to load API keys')
            const data = await response.json()
            setClusters(Array.isArray(data.clusters) ? data.clusters : [])
            setError(null)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load API keys')
        } finally {
            if (!silent) setIsLoading(false)
        }
    }, [])

    useEffect(() => {
        void fetchClusters()
    }, [fetchClusters])

    const refetch = useCallback(() => fetchClusters({ silent: true }), [fetchClusters])

    if (isLoading) {
        return <LoadingBlock label="Loading API keys..." className="py-12" />
    }

    const withKey = clusters.filter(c => c.key !== null).length
    const columnCount = canManage ? 5 : 4

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-lg font-medium text-ink">API keys</h3>
                <p className="text-sm text-ink-muted">
                    {clusters.length === 0
                        ? 'One key per cluster, used by its scanner to upload inventories and SBOMs.'
                        : `${withKey} of ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} with a key. Each key is used only by that cluster’s scanner.`}
                </p>
            </div>

            {error && (
                <div className="flex items-start gap-2 rounded-md border border-danger-muted bg-danger-subtle p-4">
                    <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" />
                    <p className="text-sm text-danger">{error}</p>
                </div>
            )}

            <TableContainer>
                <Table density="spacious" aria-label="API keys">
                    <TableHead>
                        <TableHeader>Cluster</TableHeader>
                        <TableHeader>Key</TableHeader>
                        <TableHeader hideBelow="md">Created</TableHeader>
                        <TableHeader hideBelow="lg">Last used</TableHeader>
                        {canManage && <TableHeader srOnly>Actions</TableHeader>}
                    </TableHead>
                    {clusters.length === 0 ? (
                        <TableEmpty colSpan={columnCount}>
                            No clusters yet. Connect a cluster and its key is minted with it.
                        </TableEmpty>
                    ) : (
                        <TableBody>
                            {clusters.map(cluster => (
                                <ApiKeyRow
                                    key={cluster.id}
                                    cluster={cluster}
                                    canManage={canManage}
                                    onChanged={refetch}
                                    onError={setError}
                                />
                            ))}
                        </TableBody>
                    )}
                </Table>
            </TableContainer>

            {canManage && (
                <p className="text-xs text-ink-muted">
                    Revealing a key is recorded with who did it. A rotated key replaces the old one at once, so update the
                    scanner&apos;s Secret in the cluster right after.
                </p>
            )}
        </div>
    )
}
