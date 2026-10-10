'use client'

import { Layers, Package } from 'lucide-react'
import {
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui'
import { SourceTables, KeyHint, SevCounts, ErrorBox, LoadingBox } from './Shared'
import { formatNumber, formatTimeAgo } from './utils'
import { useExplorerFetch } from './explorerShared'
import { shortDigest } from '@/utils/containerUtils'
import type { RecentOrg, ExplorerImage, ExplorerImagesData } from './types'

// ── Level 2: images with an SBOM ─────────────────────────────────────────────

export function ExplorerImageList({ org, onSelectImage }: { org: RecentOrg; onSelectImage: (i: ExplorerImage) => void }) {
    const { data, isLoading, error } = useExplorerFetch<ExplorerImagesData>(`/api/admin/explorer/images?orgId=${org.id}`)

    if (isLoading) return <LoadingBox />
    if (error) return <ErrorBox message={error} />
    if (!data) return null

    if (data.images.length === 0) {
        return (
            <div className="rounded-md bg-surface-raised border border-edge p-8 text-center">
                <Layers className="size-8 text-ink-faint/70 mx-auto mb-2" />
                <p className="text-sm text-ink-muted">No scanned images in this organization.</p>
            </div>
        )
    }

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-ink-secondary">Images</h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                        One row per distinct digest — an image running in five namespaces appears
                        once, with a deployment count. Pick one to inspect its SBOM.
                    </p>
                    <p className="mt-1 break-all"><KeyHint column="workload_containers.org_id" value={org.id} /></p>
                </div>
                <SourceTables tables={['images', 'sboms', 'workload_containers']} />
            </div>
            <TableContainer variant="plain">
                <Table aria-label="Images">
                    <TableHead>
                        <TableHeader>Image</TableHeader>
                        <TableHeader align="end" hideBelow="md">Deployments</TableHeader>
                        <TableHeader align="end" hideBelow="sm">Components</TableHeader>
                        <TableHeader>Vulnerabilities</TableHeader>
                        <TableHeader align="end" hideBelow="lg">Scanned</TableHeader>
                    </TableHead>
                    <TableBody>
                        {data.images.map((i) => (
                            <TableRow key={i.imageId} className="group" onClick={() => onSelectImage(i)}>
                                <TableCell>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            onSelectImage(i)
                                        }}
                                        className="text-left cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                    >
                                        <span className="block text-xs sm:text-sm font-medium text-ink group-hover:text-accent break-all">
                                            {i.repository ?? i.registry ?? 'Unknown'}
                                        </span>
                                        {/* The full digest wraps over three lines at
                                            phone width; twelve hex characters are the
                                            label everywhere else in the explorer. */}
                                        <span className="block text-xs text-ink-muted font-mono break-all" title={i.digest}>
                                            <span className="sm:hidden">{shortDigest(i.digest)}</span>
                                            <span className="hidden sm:inline">{i.digest}</span>
                                        </span>
                                    </button>
                                </TableCell>
                                <TableCell align="end" hideBelow="md" className="text-ink-secondary">
                                    <span className="inline-flex items-center gap-1 justify-end">
                                        <Layers className="size-3 text-ink-faint" /> {formatNumber(i.deploymentCount)}
                                    </span>
                                </TableCell>
                                <TableCell align="end" hideBelow="sm" className="text-ink-secondary">
                                    <span className="inline-flex items-center gap-1 justify-end">
                                        <Package className="size-3 text-ink-faint" /> {formatNumber(i.componentCount)}
                                    </span>
                                </TableCell>
                                <TableCell><SevCounts counts={i.vulnCounts} /></TableCell>
                                <TableCell align="end" hideBelow="lg" className="text-xs text-ink-muted whitespace-nowrap">{formatTimeAgo(i.createdAt)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    )
}
