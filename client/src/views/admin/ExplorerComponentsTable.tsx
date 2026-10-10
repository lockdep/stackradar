'use client'

import { useState, useEffect } from 'react'
import { Search } from 'lucide-react'
import {
    Button,
    PackageTypeBadge,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
    TableEmpty,
} from '@/components/ui'
import { SourceTables, KeyHint, SevCounts, ErrorBox, LoadingBox } from './Shared'
import { formatNumber } from './utils'
import { sbomLabel, useExplorerFetch } from './explorerShared'
import type { ExplorerSbom, ExplorerComponent, ExplorerComponentsData } from './types'
import { PAGE_SIZE } from '@/lib/constants'

// ── Level 3: SBOM components table ───────────────────────────────────────────

export function ExplorerComponentsTable({ sbom, onSelectComponent }: { sbom: ExplorerSbom; onSelectComponent: (c: ExplorerComponent) => void }) {
    const [search, setSearch] = useState('')
    const [debounced, setDebounced] = useState('')
    const [offset, setOffset] = useState(0)

    useEffect(() => {
        const t = setTimeout(() => { setDebounced(search); setOffset(0) }, 300)
        return () => clearTimeout(t)
    }, [search])

    const params = new URLSearchParams({ sbomId: sbom.id, limit: String(PAGE_SIZE), offset: String(offset) })
    if (debounced.trim()) params.set('search', debounced.trim())
    const { data, isLoading, error } = useExplorerFetch<ExplorerComponentsData>(`/api/admin/explorer/components?${params.toString()}`)

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5">
            <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="text-sm font-semibold text-ink-secondary">Components</h2>
                        <SourceTables tables={['components']} />
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">
                        {formatNumber(sbom.componentCount)} in this SBOM · {sbom.format.toUpperCase()} {sbom.specVersion} · {sbomLabel(sbom)}
                    </p>
                    <p className="mt-0.5"><KeyHint column="components.sbom_id" value={sbom.id} /></p>
                </div>
                <div className="relative w-full sm:w-auto">
                    <Search className="size-4 text-ink-faint absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search name or PURL…"
                        className="pl-8 pr-3 py-1.5 text-sm border border-edge rounded-md w-full sm:w-64 focus:outline-none focus:ring-2 focus:ring-accent-emphasis/30 focus:border-accent-emphasis"
                    />
                </div>
            </div>

            {isLoading ? (
                <LoadingBox />
            ) : error ? (
                <ErrorBox message={error} />
            ) : data ? (
                <>
                    <TableContainer variant="plain">
                        <Table aria-label="Components">
                            <TableHead>
                                <TableHeader>Name</TableHeader>
                                <TableHeader hideBelow="sm">Version</TableHeader>
                                <TableHeader hideBelow="md">Type</TableHeader>
                                <TableHeader hideBelow="lg">PURL</TableHeader>
                                <TableHeader>Vulnerabilities</TableHeader>
                            </TableHead>
                            {data.components.length === 0 ? (
                                <TableEmpty colSpan={5}>No components match.</TableEmpty>
                            ) : (
                                <TableBody>
                                    {data.components.map((c) => (
                                        <TableRow key={c.id} className="group" onClick={() => onSelectComponent(c)}>
                                            <TableCell>
                                                <button
                                                    type="button"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        onSelectComponent(c)
                                                    }}
                                                    className="text-xs sm:text-sm font-medium text-ink group-hover:text-accent text-left cursor-pointer rounded-sm break-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                                >
                                                    {c.groupName ? `${c.groupName} / ` : ''}{c.name}
                                                </button>
                                                {c.isDirect && <span className="ml-2 text-[10px] uppercase tracking-wide text-accent bg-accent-subtle px-1 py-0.5 rounded-sm">direct</span>}
                                                {/* The version rides under the name on phones, where its column is gone. */}
                                                {c.version && <span className="sm:hidden block text-xs text-ink-muted font-mono">{c.version}</span>}
                                            </TableCell>
                                            <TableCell hideBelow="sm" className="text-ink-secondary font-mono">{c.version ?? '—'}</TableCell>
                                            <TableCell hideBelow="md"><PackageTypeBadge packageType={c.type} /></TableCell>
                                            <TableCell hideBelow="lg" className="text-xs text-ink-muted font-mono max-w-xs truncate" title={c.purl ?? undefined}>{c.purl ?? '—'}</TableCell>
                                            <TableCell><SevCounts counts={c.vulnCounts} /></TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                    </TableContainer>

                    {data.total > PAGE_SIZE && (
                        <div className="flex items-center justify-between mt-4 text-sm text-ink-muted">
                            <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {formatNumber(data.total)}</span>
                            <div className="flex gap-2">
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={offset === 0}
                                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                                >
                                    Prev
                                </Button>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    disabled={offset + PAGE_SIZE >= data.total}
                                    onClick={() => setOffset(offset + PAGE_SIZE)}
                                >
                                    Next
                                </Button>
                            </div>
                        </div>
                    )}
                </>
            ) : null}
        </div>
    )
}
