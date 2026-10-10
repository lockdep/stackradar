'use client'

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronDown, ChevronRight, Search, CloudUpload, ShieldCheck, AlertTriangle, Loader2, XCircle, Info, X, Clock, Package, FileCode } from 'lucide-react'
import {
    VulnerabilityCounts,
    VulnerabilitySquare,
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
    TableEmpty,
    TierLensControl,
    TierLensEmpty,
} from '@/components/ui'
import { useTierLens } from '@/hooks'
import { SHOWN_DESPITE_LENS_LABEL, withTierParam, type TierLens } from '@/lib/tier-lens'
import { formatDate, formatRelativeTime } from '@/utils/formatters'
import type { ContainerExposure, VulnerabilityGroup, GroupedVulnerabilitiesResponse, VulnScanStatus } from '@/types/container'
import type { VulnerabilitiesTabProps } from './types'
import { HighlightMatch, VulnerabilityRow } from './VulnerabilityRow'
import {
    SEVERITY_BANDS,
    DEFAULT_SEVERITY_FILTER,
    UNSCORED_HIDDEN_HINT,
    filterBySeverity,
    type SeverityBand,
    type SeverityFilter,
} from '@/lib/severity'

const BAND_LABEL: Record<SeverityBand, string> = {
    critical: 'Critical',
    high: 'High',
    medium: 'Medium',
    low: 'Low',
}

/** A group after the severity filter: what to render, and how much was cut. */
type FilteredGroup = VulnerabilityGroup & { hiddenUnscored: number }

function ComponentSection({ group, isExpanded, onToggle, searchQuery = '', onIncludeUnscored, lens, exposure }: {
    exposure?: ContainerExposure['findings']
    group: FilteredGroup
    isExpanded: boolean
    onToggle: () => void
    searchQuery?: string
    onIncludeUnscored: () => void
    lens: TierLens
}) {
    // A package is wholly inside or outside a lens, so one kept finding means
    // the whole row is here on the exploited override — and says so.
    const despiteLens = group.vulnerabilities.some(v => v.shownDespiteTier)

    // Computed server-side, by the same comparators the matcher uses. Ordering
    // versions is package-manager-specific work and does not belong in the view.
    const fixVersion = group.fixVersion

    return (
        <Fragment>
            <TableRow onClick={onToggle} className={isExpanded ? 'bg-surface-hover' : ''}>
                <TableCell align="center" className="pl-0 pr-0 text-ink-muted w-10 align-middle">
                    <button
                        type="button"
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} vulnerabilities for ${group.componentName}`}
                        onClick={(e) => {
                            e.stopPropagation()
                            onToggle()
                        }}
                        className="cursor-pointer rounded-sm p-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                    >
                        {isExpanded
                            ? <ChevronDown aria-hidden="true" className="w-4 h-4 inline-block" />
                            : <ChevronRight aria-hidden="true" className="w-4 h-4 inline-block" />}
                    </button>
                </TableCell>
                <TableCell className="pl-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span
                            className="text-xs sm:text-sm font-medium text-ink truncate"
                            /* The Dockerfile line that put the package in the image,
                               when the scanner sent the layers — hover, not a column. */
                            title={group.layerCreatedBy ? `Added by: ${group.layerCreatedBy}` : undefined}
                        >
                            <HighlightMatch text={group.componentName} query={searchQuery} />
                        </span>
                        {group.componentVersion && (
                            <span className="text-xs font-mono text-ink-muted">@{group.componentVersion}</span>
                        )}
                        {despiteLens && lens !== 'all' && (
                            <span
                                className="shrink-0 text-xs text-ink-muted"
                                title="Outside this view, shown because it is on CISA KEV or has EPSS ≥ 0.1"
                            >
                                {SHOWN_DESPITE_LENS_LABEL[lens]}
                            </span>
                        )}
                    </div>
                </TableCell>
                <TableCell hideBelow="md">
                    <ScopeBadge isDirect={group.isDirect} />
                </TableCell>
                <TableCell hideBelow="md">
                    {group.packageType ? (
                        <PackageTypeBadge packageType={group.packageType} />
                    ) : (
                        <span className="text-ink-muted text-sm">—</span>
                    )}
                </TableCell>
                <TableCell hideBelow="xl" className="max-w-[200px]">
                    <OriginPath
                        isDirect={group.isDirect}
                        dependencyPath={group.dependencyPath}
                        location={group.location}
                        componentName={group.componentName}
                    />
                </TableCell>
                <TableCell hideBelow="sm">
                    {fixVersion ? (
                        <code className="text-sm font-mono text-success">{fixVersion}</code>
                    ) : (
                        <span className="text-sm text-ink-muted">—</span>
                    )}
                </TableCell>
                <TableCell>
                    <div className="flex items-center justify-end">
                        <VulnerabilitySquare count={group.counts.critical} severity="critical" />
                        <VulnerabilitySquare count={group.counts.high} severity="high" />
                        <VulnerabilitySquare count={group.counts.medium} severity="medium" />
                        <VulnerabilitySquare count={group.counts.low} severity="low" />
                    </div>
                </TableCell>
            </TableRow>

            {isExpanded && (
                /* Raw `<tr>`/`<td>`: this cell is a bare mount point for the nested
                   table, not a data cell — it must have no padding of its own. */
                <tr>
                    <td colSpan={8} className="p-0">
                        <div className="bg-surface-muted/60 border-t border-edge">
                            {group.bumpCommand && (
                                /* Advice for the reader's own repository, where the image is
                                   built from — text to copy, never a button: nothing in
                                   StackRadar can apply it. */
                                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-edge/60 py-2 pl-10 pr-3 text-xs text-ink-muted">
                                    <span>Fixes {fixVersion ? 'all of these' : 'these'} in your build:</span>
                                    <code className="select-all break-all rounded-sm bg-surface px-1.5 py-0.5 font-mono text-ink">
                                        {group.bumpCommand}
                                    </code>
                                    <span>then rebuild the image.</span>
                                </p>
                            )}
                            <Table density="condensed" aria-label={`Vulnerabilities in ${group.componentName}`}>
                                <TableHead filled={false}>
                                    <TableHeader srOnly className="w-7 pl-8 pr-1">Expand</TableHeader>
                                    <TableHeader>Severity</TableHeader>
                                    <TableHeader>ID</TableHeader>
                                    <TableHeader hideBelow="xl">Affected</TableHeader>
                                    <TableHeader hideBelow="lg">Fixed in</TableHeader>
                                    {/* Risk left of CVSS. CVSS is one of its
                                        inputs, and the pair sitting together is
                                        what makes an exploited 5.3 above an
                                        untouched 9.8 read as a claim rather
                                        than a glitch. */}
                                    <TableHeader>Risk</TableHeader>
                                    <TableHeader hideBelow="lg">CVSS</TableHeader>
                                    <TableHeader hideBelow="xl">Published</TableHeader>
                                    {exposure && (
                                        <TableHeader hideBelow="lg" align="end">
                                            <span title="How long this container has run an image carrying the advisory while it was public — across image changes, not just the current one">
                                                Exposed
                                            </span>
                                        </TableHeader>
                                    )}
                                </TableHead>
                                <TableBody>
                                    {group.vulnerabilities.map(vuln => (
                                        <VulnerabilityRow key={vuln.id} vuln={vuln} searchQuery={searchQuery} exposure={exposure} />
                                    ))}
                                    {group.hiddenUnscored > 0 && (
                                        /* The cut is stated where it was made, so an
                                           expanded component never silently shows
                                           fewer rows than the scan recorded. */
                                        <tr>
                                            <td colSpan={exposure ? 9 : 8} className="pl-10 py-1.5 text-xs text-ink-muted border-t border-edge/60">
                                                {group.hiddenUnscored} unscored {group.hiddenUnscored === 1 ? 'advisory' : 'advisories'} hidden
                                                {' · '}
                                                <button
                                                    type="button"
                                                    onClick={(e) => { e.stopPropagation(); onIncludeUnscored() }}
                                                    className="text-accent hover:underline cursor-pointer"
                                                >
                                                    show
                                                </button>
                                            </td>
                                        </tr>
                                    )}
                                </TableBody>
                            </Table>
                        </div>
                    </td>
                </tr>
            )}
        </Fragment>
    )
}

/**
 * Compact freshness/provenance bar shown above the component table.
 *
 * Image identity (registry, imageRef, imageDigest) and pod-derived
 * breadcrumbs (cluster, helm release, etc.) live in the container header
 * already, so this bar deliberately sticks to "how fresh is this data?"
 * (SBOM upload time, OSV scan time) and "how was it produced?" (format,
 * tool, hash). The only inline status that gets dedicated UI is a vuln-scan
 * warning banner when the scan isn't healthy.
 */
function VulnScanContext({ currentSbom, vulnScan }: {
    currentSbom: GroupedVulnerabilitiesResponse['currentSbom']
    vulnScan: GroupedVulnerabilitiesResponse['vulnScan']
}) {
    if (!currentSbom && !vulnScan) return null

    const status = vulnScan?.status
    const isWarning = status && status !== 'completed'

    const toolLabel = currentSbom?.toolName
        ? currentSbom.toolVersion
            ? `${currentSbom.toolName} ${currentSbom.toolVersion}`
            : currentSbom.toolName
        : null

    const hashPrefix = currentSbom?.sbomSha256?.slice(0, 8)

    return (
        <div className="mb-4 space-y-2">
            {currentSbom && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-md border border-edge bg-surface-muted/60 px-3 py-2 text-xs">
                    <span className="inline-flex items-center gap-1.5 text-ink-secondary" title={formatDate(currentSbom.createdAt)}>
                        <Clock className="size-3.5 text-ink-faint" />
                        <span>SBOM uploaded</span>
                        <span className="font-medium text-ink">{formatRelativeTime(currentSbom.createdAt)}</span>
                    </span>

                    <span className="inline-flex items-center gap-1.5 text-ink-secondary">
                        <Package className="size-3.5 text-ink-faint" />
                        <span className="font-medium text-ink">{currentSbom.componentCount}</span>
                        <span>components</span>
                    </span>

                    {vulnScan?.completedAt && (
                        <span
                            className="inline-flex items-center gap-1.5 text-ink-secondary"
                            title={`Last OSV scan: ${formatDate(vulnScan.completedAt)}`}
                        >
                            <ShieldCheck className="size-3.5 text-ink-faint" />
                            <span>OSV scan</span>
                            <span className="font-medium text-ink">{formatRelativeTime(vulnScan.completedAt)}</span>
                        </span>
                    )}

                    <span className="ml-auto inline-flex items-center gap-x-3 text-ink-muted">
                        <span className="inline-flex items-center gap-1.5" title="SBOM format and spec version">
                            <FileCode className="size-3.5" />
                            <span className="uppercase font-medium tracking-wide">{currentSbom.format} {currentSbom.specVersion}</span>
                        </span>
                        {toolLabel && (
                            <span title="Generated by">
                                {toolLabel}
                            </span>
                        )}
                        {hashPrefix && (
                            <code className="font-mono" title={`SHA-256: ${currentSbom.sbomSha256}`}>
                                #{hashPrefix}
                            </code>
                        )}
                    </span>
                </div>
            )}

            {isWarning && (() => {
                const config: Record<Exclude<VulnScanStatus, 'completed'>, {
                    icon: React.ReactNode
                    message: string
                    className: string
                }> = {
                    pending: {
                        icon: <Loader2 className="w-4 h-4 animate-spin" />,
                        message: 'Vulnerability scan is queued...',
                        className: 'bg-attention-subtle border-attention-muted text-attention',
                    },
                    processing: {
                        icon: <Loader2 className="w-4 h-4 animate-spin" />,
                        message: 'Vulnerability scan is in progress...',
                        className: 'bg-attention-subtle border-attention-muted text-attention',
                    },
                    stale: {
                        icon: <AlertTriangle className="w-4 h-4" />,
                        message: 'Vulnerabilities for the latest SBOM upload have not been processed yet',
                        className: 'bg-attention-subtle border-attention-muted text-attention',
                    },
                    not_started: {
                        icon: <Info className="w-4 h-4" />,
                        message: 'No vulnerability scan has been run for this SBOM',
                        className: 'bg-attention-subtle border-attention-muted text-attention',
                    },
                    failed: {
                        icon: <XCircle className="w-4 h-4" />,
                        message: 'Vulnerability scan failed',
                        className: 'bg-danger-subtle border-danger-muted text-danger',
                    },
                }

                const { icon, message, className } = config[status as Exclude<VulnScanStatus, 'completed'>]

                return (
                    <div className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-md ${className}`}>
                        {icon}
                        <span>{message}</span>
                    </div>
                )
            })()}
        </div>
    )
}

export function VulnerabilitiesTab(props: VulnerabilitiesTabProps) {
    const { lens, setLens } = useTierLens(props.defaultLens)
    // Same response shape from either route; findings belong to the image.
    const base = props.imageId !== undefined
        ? `/api/images/${props.imageId}/vulnerabilities/grouped`
        : `/api/containers/${props.containerId}/vulnerabilities/grouped`
    const query = withTierParam(new URLSearchParams(), lens).toString()
    const endpoint = query ? `${base}?${query}` : base
    const exposure = props.exposure
    const [data, setData] = useState<GroupedVulnerabilitiesResponse | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isStale, setIsStale] = useState(false)
    const [expandedComponents, setExpandedComponents] = useState<Set<string>>(new Set())
    const [searchQuery, setSearchQuery] = useState('')
    const [severityFilter, setSeverityFilter] = useState<SeverityFilter>(DEFAULT_SEVERITY_FILTER)

    const toggleBand = (band: SeverityBand) => {
        setSeverityFilter(prev => {
            const bands = new Set(prev.bands)
            if (bands.has(band)) bands.delete(band)
            else bands.add(band)
            return { ...prev, bands }
        })
    }
    const setIncludeUnscored = (includeUnscored: boolean) =>
        setSeverityFilter(prev => ({ ...prev, includeUnscored }))
    
    const fetchData = useCallback(async () => {
        try {
            // Only the first load blanks the tab (`isLoading` starts true); a
            // lens change keeps the table, and the control the reader just
            // clicked, on screen and dims it.
            setIsStale(true)
            const response = await fetch(endpoint)
            if (!response.ok) throw new Error('Failed to fetch vulnerabilities')
            const result: GroupedVulnerabilitiesResponse = await response.json()
            setData(result)
        } catch (err) {
            console.error('Error fetching vulnerabilities:', err)
        } finally {
            setIsLoading(false)
            setIsStale(false)
        }
    }, [endpoint])

    useEffect(() => { fetchData() }, [fetchData])

    const toggleComponent = (key: string) => {
        setExpandedComponents(prev => {
            const next = new Set(prev)
            if (next.has(key)) {
                next.delete(key)
            } else {
                next.add(key)
            }
            return next
        })
    }

    const { filteredGroups, hiddenUnscoredTotal } = useMemo(() => {
        if (!data) return { filteredGroups: [] as FilteredGroup[], hiddenUnscoredTotal: 0 }
        const q = searchQuery.trim().toLowerCase()
        const searched = !q ? data.groups : data.groups.filter(g =>
            g.componentName.toLowerCase().includes(q) ||
            // Collapsed ids are searchable too: a CVE folded into a GHSA row is
            // still a CVE the user was told about elsewhere, and searching for
            // it must not come back empty.
            g.vulnerabilities.some(v =>
                v.vulnId.toLowerCase().includes(q) ||
                (v.aliasIds ?? []).some(id => id.toLowerCase().includes(q))
            )
        )
        // Severity filter per finding, then drop a component with nothing left
        // to show — a package whose only advisories are unscored is exactly
        // the noise the default filter exists to remove. Its group counts are
        // left as the server computed them: the four squares only ever count
        // scored findings, so they are unaffected by the unscored cut.
        let hiddenUnscoredTotal = 0
        const filteredGroups: FilteredGroup[] = []
        for (const g of searched) {
            const { shown, hiddenUnscored } = filterBySeverity(g.vulnerabilities, severityFilter)
            hiddenUnscoredTotal += hiddenUnscored
            if (shown.length > 0) filteredGroups.push({ ...g, vulnerabilities: shown, hiddenUnscored })
        }
        return { filteredGroups, hiddenUnscoredTotal }
    }, [data, searchQuery, severityFilter])

    if (isLoading) {
        return (
            <LoadingBlock label="Loading vulnerabilities..." />
        )
    }

    if (!data) return null

    const { summary, hasDependencies, currentSbom, vulnScan, tierCounts } = data
    const unscoredTotal = summary.unscored ?? 0
    /* "No findings at all" is a statement about the image, not about the
       lens: an empty Application view over a full base image still renders
       the control and its empty state below. */
    const hasFindings = (tierCounts?.all ?? data.groups.length) > 0

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3 mb-5">
                <span className="text-sm font-medium text-ink-muted">Vulnerabilities:</span>
                <VulnerabilityCounts
                    critical={summary.critical}
                    high={summary.high}
                    medium={summary.medium}
                    low={summary.low}
                />
                {unscoredTotal > 0 && (
                    <span className="text-xs text-ink-muted" title={UNSCORED_HIDDEN_HINT}>
                        + {unscoredTotal} unscored
                    </span>
                )}
            </div>

            <VulnScanContext currentSbom={currentSbom} vulnScan={vulnScan} />

            {!hasFindings ? (
                !hasDependencies ? (
                    <div className="text-center py-12">
                        <div className="mx-auto w-12 h-12 bg-accent-subtle rounded-sm flex items-center justify-center mb-3">
                            <CloudUpload className="w-6 h-6 text-accent" />
                        </div>
                        <h3 className="text-sm font-medium text-ink mb-1.5">No SBOM uploaded yet</h3>
                        <p className="text-xs text-ink-muted max-w-sm mx-auto">
                            Vulnerabilities will appear here once your scanner uploads an SBOM for this image.
                        </p>
                    </div>
                ) : vulnScan?.status === 'completed' ? (
                    <div className="text-center py-10">
                        <ShieldCheck className="w-8 h-8 text-success mx-auto mb-2" />
                        <p className="text-xs text-ink-muted">No vulnerabilities found. Great job keeping your dependencies secure!</p>
                    </div>
                ) : (
                    <div className="text-center py-10">
                        <Info className="w-8 h-8 text-ink-faint/70 mx-auto mb-2" />
                        <p className="text-xs text-ink-muted">Vulnerability results will appear here once a scan has run.</p>
                    </div>
                )
            ) : (
                <>
                    <TierLensControl lens={lens} onChange={setLens} counts={tierCounts} className="mb-4" />
                    <div className="flex flex-wrap items-center justify-between mb-4 gap-x-4 gap-y-2">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 flex-1">
                            <div className="relative flex-1 min-w-48 max-w-xs">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-faint" />
                                <input
                                    type="text"
                                    placeholder="Search components or CVE IDs..."
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
                            <span className="text-sm text-ink-secondary whitespace-nowrap">
                                <span className="font-medium">{filteredGroups.length}</span> {filteredGroups.length === 1 ? 'component' : 'components'}
                            </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                            <div
                                role="group"
                                aria-label="Filter by severity"
                                className="inline-flex rounded-md border border-edge bg-surface-muted p-0.5 gap-0.5"
                            >
                                {SEVERITY_BANDS.map(band => {
                                    const on = severityFilter.bands.has(band)
                                    return (
                                        <button
                                            key={band}
                                            type="button"
                                            aria-pressed={on}
                                            onClick={() => toggleBand(band)}
                                            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                                                on
                                                    ? 'bg-surface-raised text-ink shadow-resting'
                                                    : 'text-ink-muted hover:text-ink-secondary line-through'
                                            }`}
                                        >
                                            {BAND_LABEL[band]}
                                            <span className="ml-1 tabular-nums text-ink-muted">{summary[band]}</span>
                                        </button>
                                    )
                                })}
                            </div>

                            {unscoredTotal > 0 && (
                                <label
                                    className="inline-flex items-center gap-1.5 text-xs text-ink-secondary cursor-pointer select-none whitespace-nowrap"
                                    title={UNSCORED_HIDDEN_HINT}
                                >
                                    <input
                                        type="checkbox"
                                        checked={severityFilter.includeUnscored}
                                        onChange={(e) => setIncludeUnscored(e.target.checked)}
                                        className="accent-accent-emphasis"
                                    />
                                    Include unscored
                                    <span className="tabular-nums text-ink-muted">
                                        ({severityFilter.includeUnscored ? unscoredTotal : hiddenUnscoredTotal} {severityFilter.includeUnscored ? 'shown' : 'hidden'})
                                    </span>
                                </label>
                            )}
                        </div>
                    </div>

                    <TableContainer variant="section" className={isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                        <Table aria-label="Vulnerable components">
                            <TableHead>
                                <TableHeader srOnly className="w-10 pl-0 pr-0">Expand</TableHeader>
                                <TableHeader className="pl-0">Component</TableHeader>
                                <TableHeader hideBelow="md">Scope</TableHeader>
                                <TableHeader hideBelow="md">Type</TableHeader>
                                <TableHeader hideBelow="xl">Origin</TableHeader>
                                <TableHeader hideBelow="sm">Fix version</TableHeader>
                                <TableHeader align="end">Vulnerabilities</TableHeader>
                            </TableHead>
                            {filteredGroups.length === 0 ? (
                                <TableEmpty colSpan={7}>
                                    {searchQuery.trim()
                                        ? 'No matching components found.'
                                        : data.groups.length === 0 && lens !== 'all'
                                            ? <TierLensEmpty lens={lens} counts={tierCounts} onChange={setLens} />
                                        : hiddenUnscoredTotal > 0
                                            ? 'Every remaining finding is unscored. Tick “Include unscored” to see them.'
                                            : 'No findings match the selected severities.'}
                                </TableEmpty>
                            ) : (
                                <TableBody>
                                    {filteredGroups.map(group => (
                                        <ComponentSection
                                            key={group.componentId}
                                            group={group}
                                            isExpanded={expandedComponents.has(group.componentId)}
                                            onToggle={() => toggleComponent(group.componentId)}
                                            searchQuery={searchQuery.trim()}
                                            onIncludeUnscored={() => setIncludeUnscored(true)}
                                            lens={lens}
                                            exposure={exposure?.findings}
                                        />
                                    ))}
                                </TableBody>
                            )}
                        </Table>
                    </TableContainer>
                </>
            )}
        </div>
    )
}
