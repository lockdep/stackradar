'use client'

import { useState, useEffect, useCallback, useMemo, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert, Search, CloudUpload, X } from 'lucide-react'
import {
    LoadingBlock,
    ScopeBadge,
    PackageTypeBadge,
    OriginPath,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableHeader,
    TableRow,
    TableCell,
} from '@/components/ui'

import type { DependencyOverviewItem, DependenciesOverviewResponse } from '@/types/container'
import type { DependenciesTabProps, SbomItem } from './types'

// Detail and overflow rows sit one nesting level in, plus the width of the
// disclosure chevron so their text lines up with the parent row's name.
const NESTED_DETAIL_INDENT = 'calc(var(--tree-level) * var(--tree-indent) + 24px)'

type VisibleColumns = {
    version: boolean
    scope: boolean
    type: boolean
    origin: boolean
    license: boolean
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
    if (!query) return <>{text}</>
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return <>{text}</>
    return (
        <>
            {text.slice(0, idx)}
            <mark className="bg-attention-subtle text-inherit rounded-sm px-px">{text.slice(idx, idx + query.length)}</mark>
            {text.slice(idx + query.length)}
        </>
    )
}

function DependencyRow({ 
    dep, 
    isExpanded, 
    onToggle,
    depsById,
    expandedIds,
    onToggleChild,
    visibleColumns,
    searchQuery = '',
    depth = 0
}: { 
    dep: DependencyOverviewItem
    isExpanded: boolean
    onToggle: () => void
    depsById: Map<string, DependencyOverviewItem>
    expandedIds: Set<string>
    onToggleChild: (id: string) => void
    visibleColumns: VisibleColumns
    searchQuery?: string
    depth?: number
}) {
    const hasVulns = dep.vulnerabilities.length > 0
    const hasChildren = dep.children.length > 0
    const maxDepth = 3
    
    const rowBg = depth > 0 ? 'bg-surface-hover/50' : ''

    return (
        <>
            <TableRow className={rowBg} onClick={onToggle}>
                <TableCell>
                    <div
                        className="tree-indent flex items-center gap-2"
                        style={{ '--tree-level': depth } as CSSProperties}
                    >
                        <button
                            type="button"
                            aria-expanded={isExpanded}
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${dep.name}`}
                            onClick={(e) => {
                                e.stopPropagation()
                                onToggle()
                            }}
                            className="text-ink-faint cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                        >
                            {isExpanded ? <ChevronDown aria-hidden="true" className="w-4 h-4" /> : <ChevronRight aria-hidden="true" className="w-4 h-4" />}
                        </button>
                        <span className="font-medium text-ink"><HighlightMatch text={dep.name} query={searchQuery} /></span>
                        {hasVulns && (
                            <TriangleAlert className="w-4 h-4 text-attention" />
                        )}
                        {hasChildren && (
                            <span className="text-xs text-ink-muted">({dep.children.length})</span>
                        )}
                    </div>
                </TableCell>
                {visibleColumns.version && (
                    <TableCell className="text-xs text-ink-secondary font-mono">{dep.version ? <HighlightMatch text={dep.version} query={searchQuery} /> : '-'}</TableCell>
                )}
                {visibleColumns.scope && (
                    <TableCell hideBelow="md">
                        <ScopeBadge isDirect={dep.isDirect} />
                    </TableCell>
                )}
                {visibleColumns.type && (
                    <TableCell hideBelow="md">
                        {dep.packageType ? (
                            <PackageTypeBadge packageType={dep.packageType} />
                        ) : (
                            <span className="text-ink-muted">—</span>
                        )}
                    </TableCell>
                )}
                {visibleColumns.origin && (
                    <TableCell hideBelow="xl" className="max-w-[200px]">
                        <OriginPath
                            isDirect={dep.isDirect}
                            dependencyPath={dep.dependencyPath}
                            location={dep.location}
                            componentName={dep.name}
                        />
                    </TableCell>
                )}
                {visibleColumns.license && (
                    <TableCell hideBelow="lg" className="text-ink-secondary">{dep.license ? <HighlightMatch text={dep.license} query={searchQuery} /> : '-'}</TableCell>
                )}
            </TableRow>
            {isExpanded && (
                <>
                    <TableRow className="bg-surface-hover/50">
                        <TableCell colSpan={6} style={{ '--tree-level': depth, paddingLeft: NESTED_DETAIL_INDENT } as CSSProperties}>
                            <div className="text-sm space-y-2">
                                {dep.purl && (
                                    <div>
                                        <span className="text-ink-muted text-xs">Package URL: </span>
                                        <code className="text-xs bg-surface-hover px-1.5 py-0.5 text-ink-secondary font-mono break-all">
                                            {dep.purl}
                                        </code>
                                    </div>
                                )}
                                {hasVulns && (
                                    <div className="py-1.5 px-2 bg-attention-subtle border-l-2 border-attention-emphasis">
                                        <span className="font-medium text-attention text-xs">Known vulnerabilities: </span>
                                        <span className="text-xs text-attention">
                                            {dep.vulnerabilities.map(v => v.id).join(', ')}
                                        </span>
                                    </div>
                                )}
                            </div>
                        </TableCell>
                    </TableRow>
                    {hasChildren && depth < maxDepth && dep.children.map(childId => {
                        const childDep = depsById.get(childId)
                        if (!childDep) return null
                        return (
                            <DependencyRow
                                key={childId}
                                dep={childDep}
                                isExpanded={expandedIds.has(childId)}
                                onToggle={() => onToggleChild(childId)}
                                depsById={depsById}
                                expandedIds={expandedIds}
                                onToggleChild={onToggleChild}
                                visibleColumns={visibleColumns}
                                searchQuery={searchQuery}
                                depth={depth + 1}
                            />
                        )
                    })}
                    {hasChildren && depth >= maxDepth && (
                        <TableRow className="bg-surface-hover/20">
                            <TableCell colSpan={6} className="text-xs text-ink-muted italic" style={{ '--tree-level': depth + 1, paddingLeft: NESTED_DETAIL_INDENT } as CSSProperties}>
                                {dep.children.length} more nested dependencies...
                            </TableCell>
                        </TableRow>
                    )}
                </>
            )}
        </>
    )
}

export function DependenciesTab({ containerId }: DependenciesTabProps) {
    const [data, setData] = useState<DependenciesOverviewResponse | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
    const [showAll, setShowAll] = useState(false)
    const [searchQuery, setSearchQuery] = useState('')
    const [sbomId, setSbomId] = useState<string | null>(null)
    const [visibleColumns, setVisibleColumns] = useState<VisibleColumns>({
        version: true,
        scope: true,
        type: true,
        origin: true,
        license: true
    })

    /* One SBOM per image, so there is nothing to pick between. The picker this
       replaces existed because a project accumulated SBOMs over time; a digest
       cannot, so the only question is whether one exists yet. */
    useEffect(() => {
        async function fetchSbom() {
            try {
                const response = await fetch(`/api/containers/${containerId}/sboms`)
                if (!response.ok) return
                const list: SbomItem[] = await response.json()
                const id = list[0]?.id ?? null
                setSbomId(id)
                if (!id) setIsLoading(false)
            } catch {
                setIsLoading(false)
            }
        }
        fetchSbom()
    }, [containerId])

    const fetchData = useCallback(async () => {
        if (!sbomId) return
        try {
            setIsLoading(true)
            const response = await fetch(`/api/containers/${containerId}/dependencies/overview?sbomId=${sbomId}`)
            if (!response.ok) throw new Error('Failed to fetch dependencies')
            const result: DependenciesOverviewResponse = await response.json()
            setData(result)
        } catch (err) {
            console.error('Error fetching dependencies:', err)
        } finally {
            setIsLoading(false)
        }
    }, [containerId, sbomId])

    useEffect(() => {
        if (sbomId) fetchData()
    }, [fetchData, sbomId])
    
    const toggleColumn = (column: keyof VisibleColumns) => {
        setVisibleColumns(prev => ({ ...prev, [column]: !prev[column] }))
    }

    const depsById = useMemo(() => {
        if (!data) return new Map<string, DependencyOverviewItem>()
        const map = new Map<string, DependencyOverviewItem>()
        for (const dep of data.dependencies) {
            map.set(dep.id, dep)
        }
        return map
    }, [data])

    const displayedDeps = useMemo(() => {
        if (!data) return []
        const baseDeps = showAll
            ? data.dependencies
            : data.dependencies.filter(d => d.isDirect)
        if (!searchQuery.trim()) return baseDeps
        
        const query = searchQuery.toLowerCase()
        return baseDeps.filter(dep => 
            dep.name.toLowerCase().includes(query) ||
            dep.version?.toLowerCase().includes(query) ||
            dep.license?.toLowerCase().includes(query) ||
            dep.purl?.toLowerCase().includes(query)
        )
    }, [data, showAll, searchQuery])
    
    const toggleExpanded = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) {
                next.delete(id)
            } else {
                next.add(id)
            }
            return next
        })
    }

    if (isLoading) {
        return (
            <LoadingBlock label="Loading dependencies..." />
        )
    }

    if (!data || data.dependencies.length === 0) {
        return (
            <div className="text-center py-16">
                <div className="mx-auto w-16 h-16 bg-accent-subtle rounded-full flex items-center justify-center mb-4">
                    <CloudUpload className="w-8 h-8 text-accent" />
                </div>
                <h3 className="text-lg font-medium text-ink mb-2">No SBOM uploaded yet</h3>
                <p className="text-ink-muted max-w-sm mx-auto">
                    Dependencies will appear here once your scanner uploads an SBOM for this container&apos;s image.
                </p>
            </div>
        )
    }

    const { summary } = data

    return (
        <div>
            <div className="flex flex-wrap items-center justify-between mb-4 gap-x-4 gap-y-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 flex-1">
                    <div className="relative flex-1 min-w-48 max-w-xs">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-faint" />
                        <input
                            type="text"
                            placeholder="Search dependencies..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-8 pr-8 py-1.5 text-sm border border-edge-strong rounded-md focus:outline-none focus:border-edge-strong"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink-secondary cursor-pointer"
                            >
                                <X className="h-4 w-4" />
                            </button>
                        )}
                    </div>
                    <div className="text-sm text-ink-secondary whitespace-nowrap">
                        <span className="font-medium">{displayedDeps.length}</span>
                        {searchQuery.trim() ? ' matching' : ''} of <span className="font-medium">{summary.direct}</span> direct, 
                        <span className="font-medium ml-1">{summary.transitive}</span> transitive
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="text-xs text-ink-muted uppercase tracking-wide">Columns:</span>
                        {(['version', 'scope', 'type', 'origin', 'license'] as const).map(col => (
                            <label key={col} className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={visibleColumns[col]}
                                    onChange={() => toggleColumn(col)}
                                    className="h-3.5 w-3.5 rounded-sm border-edge-strong text-accent focus:ring-accent-emphasis cursor-pointer"
                                />
                                <span className="text-sm text-ink-secondary capitalize">{col}</span>
                            </label>
                        ))}
                    </div>
                    {summary.transitive > 0 && (
                        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                            <span className="text-sm text-ink-secondary">Include transitive</span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={showAll}
                                onClick={() => setShowAll(!showAll)}
                                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-emphasis focus-visible:ring-offset-2 ${
                                    showAll ? 'bg-accent-emphasis' : 'bg-track'
                                }`}
                            >
                                <span
                                    aria-hidden="true"
                                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-on-emphasis shadow ring-0 transition duration-200 ease-in-out ${
                                        showAll ? 'translate-x-4' : 'translate-x-0'
                                    }`}
                                />
                            </button>
                        </label>
                    )}
                </div>
            </div>
            
            <TableContainer variant="section">
                <Table aria-label="Dependencies">
                    <TableHead>
                        <TableHeader>Name</TableHeader>
                        {visibleColumns.version && <TableHeader>Version</TableHeader>}
                        {visibleColumns.scope && <TableHeader hideBelow="md">Scope</TableHeader>}
                        {visibleColumns.type && <TableHeader hideBelow="md">Type</TableHeader>}
                        {visibleColumns.origin && <TableHeader hideBelow="xl">Origin</TableHeader>}
                        {visibleColumns.license && <TableHeader hideBelow="lg">License</TableHeader>}
                    </TableHead>
                    <TableBody>
                        {displayedDeps.map(dep => (
                            <DependencyRow 
                                key={dep.id} 
                                dep={dep} 
                                isExpanded={expandedIds.has(dep.id)}
                                onToggle={() => toggleExpanded(dep.id)}
                                depsById={depsById}
                                expandedIds={expandedIds}
                                onToggleChild={toggleExpanded}
                                visibleColumns={visibleColumns}
                                searchQuery={searchQuery.trim()}
                            />
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    )
}
