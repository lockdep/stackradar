'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronRight, ScanSearch } from 'lucide-react'
import {
    Badge,
    EntityIcon,
    FilterBar,
    FilterBarEnd,
    FilterBarRefresh,
    FilterBarReset,
    ImagesFilterMenu,
    LoadingBlock,
    RiskCell,
    ScopeFilterMenu,
    SearchInput,
    SortableHeader,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableFoot,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui'
import {
    ContainerSeverityCell,
    ContainersCoverageStrip,
    ContainersError,
    ContainersLoading,
    ScanDot,
    useContainersView,
} from '@/components/containers'
import { ImageControlTag, useSetImageControl, type ControlChoice } from '@/components/image-control'
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider'
import { useRuntimeConfig } from '@/components/providers'
import { useResource } from '@/hooks'
import { controlFilterCounts, matchesControlFilter } from '@/lib/image-control'
import { TOTAL_RISK_HINT } from '@/lib/risk'
import type { Image, ImageDeployment, SortColumn, SortDirection, VulnerabilityCounts } from '@/types/container'
import { severityScore, shortDigest } from '@/utils/containerUtils'
import { formatAge, formatDate, formatShortDate, isDigestLikeTag } from '@/utils/formatters'

/**
 * `/images` — every image running in the organisation's clusters, one row
 * per image, worst first.
 *
 * `/containers` is the same fleet counted by *where* things run: five
 * containers on one image are five rows that tie. Here they are one row with
 * a count of five, because the image is the thing a finding belongs to and
 * the thing a fix changes. Images are cluster-scoped (ADR 0006), so a digest
 * running in two clusters is two rows, told apart by the Cluster column.
 *
 * The rows are `GET /api/images`, narrowed in the browser like the
 * containers list. That endpoint also returns images that were uploaded but
 * run nowhere (`containerCount: 0`); this page is about what is running, so
 * they are left out.
 *
 * Sort, the cluster, namespace and registry scope and the filters live in the URL through the containers
 * list's own hook, so a parameter means the same thing on both pages; search
 * stays local state.
 */
export function ImagesView() {
    const { organization } = useOrganization()
    const { demoMode } = useRuntimeConfig()
    const { data, error, isLoading, isRefreshing, refetch } = useResource<Image[]>('/api/images', {
        responseError: (_res, body) => (body as { error?: string }).error || 'Failed to fetch images',
        fallbackError: 'Failed to fetch images',
        revalidateOnFocus: true,
    })
    const images = useMemo(() => (data ?? []).filter(i => i.containerCount > 0), [data])

    const {
        sortColumn,
        sortDirection,
        filters,
        clusterId,
        namespace,
        registry,
        control,
        setControl,
        toggleSort,
        toggleFilter,
        setCluster,
        setNamespace,
        setRegistry,
        clearFilters,
    } = useContainersView({ defaultSort: 'risk' })

    const [searchValue, setSearchValue] = useState('')

    /* Correcting a row's Organization / Third-party tag — owners and admins. */
    const { setControl: setImageControl, error: controlError } = useSetImageControl(refetch)

    /* Which rows are open — local state: an expansion is a glance, not a view
       worth a link. */
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
    const toggleExpanded = (id: string) =>
        setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })

    /* The rows name their own cluster, so the menu needs no second request —
       and lists only clusters that have an image to show. */
    const clusterOptions = useMemo(() => {
        const names = new Map<string, string>()
        for (const i of images) names.set(i.clusterId, i.clusterName ?? i.clusterId)
        return [...names]
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label))
    }, [images])

    const inCluster = useMemo(
        () => (clusterId ? images.filter(i => i.clusterId === clusterId) : images),
        [images, clusterId],
    )
    /* Namespace, then registry, each menu listing what the scope before it
       leaves — as on the containers list. An image matches a namespace when
       any container running it is there; a chosen value absent from the
       options (a stale link) stays listed so it can be seen and cleared. */
    const namespaceOptions = useMemo(
        () => scopeOptions(inCluster.flatMap(i => i.namespaces ?? []), namespace),
        [inCluster, namespace],
    )
    const inNamespace = useMemo(
        () => (namespace ? inCluster.filter(i => i.namespaces?.includes(namespace)) : inCluster),
        [inCluster, namespace],
    )
    const registryOptions = useMemo(
        () => scopeOptions(inNamespace.flatMap(i => (i.registry ? [i.registry] : [])), registry),
        [inNamespace, registry],
    )
    const inRegistry = useMemo(
        () => (registry ? inNamespace.filter(i => i.registry === registry) : inNamespace),
        [inNamespace, registry],
    )
    const controlCounts = useMemo(() => controlFilterCounts(inRegistry.map(i => i.control)), [inRegistry])
    const scoped = useMemo(
        () => inRegistry.filter(i => matchesControlFilter(i.control, control)),
        [inRegistry, control],
    )

    /* Coverage of the chosen scope, before the unscanned toggle and the
       search — as on the containers list. */
    const coverage = useMemo(() => {
        let scanned = 0
        for (const i of scoped) if (i.sbomId !== null) scanned++
        return { scanned, unscanned: scoped.length - scanned }
    }, [scoped])

    const rows = useMemo(() => {
        let filtered = scoped
        if (filters.has('unscanned')) filtered = filtered.filter(i => i.sbomId === null)
        if (searchValue) {
            const q = searchValue.toLowerCase()
            filtered = filtered.filter(i =>
                (i.repository ?? '').toLowerCase().includes(q) ||
                (i.registry ?? '').toLowerCase().includes(q) ||
                i.digest.toLowerCase().includes(q) ||
                (i.clusterName ?? '').toLowerCase().includes(q) ||
                i.tags.some(t => t.toLowerCase().includes(q)),
            )
        }
        return [...filtered].sort((a, b) => compareImages(a, b, sortColumn, sortDirection))
    }, [scoped, filters, searchValue, sortColumn, sortDirection])

    /* A plain sum: every row is a distinct image, so there is nothing to
       deduplicate. `null` when no row has been scanned — never four zeroes. */
    const totals = useMemo(() => {
        let sum: VulnerabilityCounts | null = null
        let containers = 0
        for (const i of rows) {
            containers += i.containerCount
            if (!i.vulnerabilities) continue
            sum ??= { critical: 0, high: 0, medium: 0, low: 0 }
            sum.critical += i.vulnerabilities.critical
            sum.high += i.vulnerabilities.high
            sum.medium += i.vulnerabilities.medium
            sum.low += i.vulnerabilities.low
        }
        return { vulnerabilities: sum, containers }
    }, [rows])

    const scopeActive = clusterId !== null || namespace !== null || registry !== null || control !== 'all'

    /* A different cluster usually has no namespace of the chosen name, so the
       param goes — unless it does. */
    const handleClusterChange = (id: string | null) => {
        const next = id ? images.filter(i => i.clusterId === id) : images
        const keepNamespace = namespace !== null && next.some(i => i.namespaces?.includes(namespace))
        setCluster(id, { keepNamespace })
    }
    const narrowed = scopeActive || filters.size > 0 || Boolean(searchValue)

    const reset = () => {
        clearFilters()
        setSearchValue('')
    }

    return (
        <div>
            <header className="pb-4">
                <h1 className="text-xl font-semibold text-ink">Images</h1>
                <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                    Every image running in your clusters, worst first. One row per image, however
                    many containers run it; the same image in two clusters is listed once for each.
                </p>
            </header>

            <FilterBar label="Image filters — apply to the whole list">
                <FilterBarRefresh onRefresh={refetch} isRefreshing={isRefreshing} label="Refresh images" />
                {images.length > 0 && (
                    <>
                        <SearchInput
                            id="image-search"
                            label="Search images"
                            placeholder="Search images"
                            value={searchValue}
                            onChange={setSearchValue}
                            className="w-full sm:w-64"
                        />
                        <FilterBarEnd>
                            {narrowed && <FilterBarReset onReset={reset} />}
                            <ScopeFilterMenu
                                label="Cluster"
                                allLabel="All clusters"
                                icon={<EntityIcon kind="cluster" className="size-4" />}
                                scope={{ value: clusterId, options: clusterOptions, onChange: handleClusterChange }}
                            />
                            {namespaceOptions.length > 0 && (
                                <ScopeFilterMenu
                                    label="Namespace"
                                    allLabel="All namespaces"
                                    scope={{ value: namespace, options: namespaceOptions, onChange: setNamespace }}
                                />
                            )}
                            {registryOptions.length > 0 && (
                                <ScopeFilterMenu
                                    label="Registry"
                                    allLabel="All registries"
                                    scope={{ value: registry, options: registryOptions, onChange: setRegistry }}
                                />
                            )}
                            <ImagesFilterMenu
                                value={control}
                                onChange={setControl}
                                counts={controlCounts}
                                canManageImages={isAdminOrOwner(organization) || demoMode}
                            />
                        </FilterBarEnd>
                    </>
                )}
            </FilterBar>

            {isLoading ? (
                <ContainersLoading label="Loading images..." />
            ) : error ? (
                <ContainersError error={error} onRetry={refetch} />
            ) : images.length === 0 ? (
                <NoImagesYet />
            ) : rows.length === 0 ? (
                <div className="mt-8 py-12 text-center">
                    <p className="text-sm text-ink-muted">No images match the current search and filters.</p>
                    {(scopeActive || filters.size > 0) && (
                        <button
                            type="button"
                            onClick={clearFilters}
                            className="mt-2 cursor-pointer text-sm text-accent underline underline-offset-2"
                        >
                            Clear filters
                        </button>
                    )}
                </div>
            ) : (
                <>
                    <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-edge pb-3">
                        <p className="text-xs text-ink-muted">
                            <span className="font-medium text-ink-secondary">Worst first</span>
                            <span className="mx-1.5 text-ink-faint">·</span>
                            Every running image in the organisation, by Radar Score.
                        </p>
                        <p className="whitespace-nowrap text-xs text-ink-muted">
                            {narrowed && <span>Matching: </span>}
                            {plural(rows.length, 'image')}
                            <span className="mx-1.5 text-ink-faint">·</span>
                            {plural(totals.containers, 'container')}
                        </p>
                    </div>
                    {controlError && (
                        <p role="alert" className="mt-3 text-xs text-danger">
                            Could not change the image&apos;s owner: {controlError}
                        </p>
                    )}
                    <ContainersCoverageStrip
                        scanned={coverage.scanned}
                        unscanned={coverage.unscanned}
                        reported
                        active={filters.has('unscanned')}
                        onToggle={toggleFilter}
                        noun="images"
                    />
                    <TableContainer variant="card" square className="mt-4">
                        {/* `table-fixed`, as on the containers list: header
                            widths are law and the image name truncates.
                            Cluster and Checked collapse below `xl`, the
                            container count below `md`; Radar Score and the
                            counts never collapse. */}
                        <Table
                            density="condensed"
                            textSize="xs"
                            aria-label="Images across all clusters"
                            className="w-full table-fixed"
                        >
                            <TableHead>
                                <SortableHeader
                                    column="name"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                >
                                    Image
                                </SortableHeader>
                                <TableHeader hideBelow="xl" className="w-32">
                                    <span title="Whether your organization builds the image or someone else does">Image owner</span>
                                </TableHeader>
                                <TableHeader hideBelow="xl" className="w-40">Cluster</TableHeader>
                                <TableHeader hideBelow="md" align="end" className="w-24">
                                    <span title="Running containers that reference this image">Containers</span>
                                </TableHeader>
                                <SortableHeader
                                    column="scannedAt"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    hideBelow="xl"
                                    className="w-24"
                                >
                                    Checked
                                </SortableHeader>
                                <SortableHeader
                                    column="firstSeen"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    hideBelow="xl"
                                    align="end"
                                    className="w-24"
                                >
                                    <span title="How long ago this image first appeared in its cluster">First seen</span>
                                </SortableHeader>
                                <SortableHeader
                                    column="built"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    hideBelow="xl"
                                    align="end"
                                    className="w-20"
                                >
                                    <span title="How long ago the image was built, from the build date in the image itself">Built</span>
                                </SortableHeader>
                                <SortableHeader
                                    column="risk"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    align="end"
                                    className="w-20 sm:w-24"
                                >
                                    <span title={TOTAL_RISK_HINT}>Radar Score</span>
                                </SortableHeader>
                                <SortableHeader
                                    column="severity"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    align="end"
                                    className="w-44"
                                >
                                    Vulnerabilities
                                </SortableHeader>
                            </TableHead>
                            <TableBody>
                                {rows.map(image => (
                                    <ImageRow
                                        key={image.id}
                                        image={image}
                                        expanded={expanded.has(image.id)}
                                        onToggle={() => toggleExpanded(image.id)}
                                        onControlChange={
                                            setImageControl && image.repository
                                                ? next => void setImageControl(image, next)
                                                : undefined
                                        }
                                    />
                                ))}
                            </TableBody>
                            <TableFoot>
                                <TableCell className="font-semibold text-ink">Total</TableCell>
                                <TableCell hideBelow="xl" />
                                <TableCell hideBelow="xl" />
                                <TableCell hideBelow="md" align="end" className="tabular-nums text-ink-secondary">
                                    {totals.containers.toLocaleString()}
                                </TableCell>
                                <TableCell hideBelow="xl" />
                                <TableCell hideBelow="xl" />
                                <TableCell hideBelow="xl" />
                                <TableCell colSpan={2} align="end" className="whitespace-nowrap">
                                    <ContainerSeverityCell vulnerabilities={totals.vulnerabilities} aggregated />
                                </TableCell>
                            </TableFoot>
                        </Table>
                    </TableContainer>
                </>
            )}
        </div>
    )
}

/**
 * One image. The name is the repository; what follows it is what the
 * deployments asked for — the tag when there is exactly one story to tell,
 * `+n` when several tags resolve to this digest, and the digest itself when
 * every deployment pins it. Null findings render as a dash, never as zeroes.
 *
 * The row opens on the containers running the image — the answer to the
 * Containers count — fetched when it is first opened. The chevron sits in
 * the name cell rather than a column of its own, so the fixed layout gives
 * the name the width.
 */
function ImageRow({
    image,
    expanded,
    onToggle,
    onControlChange,
}: {
    image: Image
    expanded: boolean
    onToggle: () => void
    /** Present when the reader may correct whose image this is. */
    onControlChange: ((next: ControlChoice) => void) | undefined
}) {
    const name = image.repository ?? image.registry ?? shortDigest(image.digest)
    const fullName = [image.registry, image.repository].filter(Boolean).join('/') || image.digest
    const tags = image.tags.filter(t => !isDigestLikeTag(t))
    const where = [image.registry, image.clusterName].filter(Boolean).join(' · ')
    const built = builtAt(image)

    return (
        <>
            <TableRow hoverable onClick={onToggle}>
                <TableCell className="align-middle">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={`${expanded ? 'Hide' : 'Show'} containers running ${name}`}
                            onClick={e => {
                                e.stopPropagation()
                                onToggle()
                            }}
                            className="shrink-0 cursor-pointer rounded-sm p-0.5 text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                        >
                            {expanded ? (
                                <ChevronDown aria-hidden="true" className="size-3.5" />
                            ) : (
                                <ChevronRight aria-hidden="true" className="size-3.5" />
                            )}
                        </button>
                        <Link
                            href={`/images/${image.id}`}
                            onClick={e => e.stopPropagation()}
                            className="group/name flex min-w-0 items-center gap-2 text-ink hover:text-accent"
                            title={`${fullName}${tags.length > 0 ? `:${tags.join(', :')}` : ''}\n${image.digest}`}
                        >
                            <EntityIcon kind="image" className="size-4 text-ink-muted" />
                            <ScanDot subject={image} />
                            <span className="min-w-0">
                                <span className="block truncate underline-offset-2 group-hover/name:underline">
                                    {name}
                                    {tags.length > 0 ? (
                                        <span className="text-ink-muted">
                                            :{tags[0]}
                                            {tags.length > 1 && ` +${tags.length - 1}`}
                                        </span>
                                    ) : (
                                        image.repository && (
                                            <span className="text-ink-muted">@{shortDigest(image.digest)}</span>
                                        )
                                    )}
                                </span>
                                {/* The registry, and the cluster while its column is collapsed. */}
                                {where && (
                                    <span className="block truncate text-xs text-ink-muted">
                                        {image.registry}
                                        {image.clusterName && (
                                            <span className="xl:hidden">
                                                {image.registry && ' · '}
                                                {image.clusterName}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </span>
                        </Link>
                    </div>
                </TableCell>

                <TableCell hideBelow="xl" className="align-middle">
                    <ImageControlTag
                        control={image.control}
                        detectedBy={image.controlDetectedBy}
                        detail={image.controlDetail}
                        repository={fullName}
                        onChange={onControlChange}
                    />
                </TableCell>

                <TableCell hideBelow="xl" className="truncate align-middle">
                    <Link
                        href={`/clusters/${image.clusterId}`}
                        onClick={e => e.stopPropagation()}
                        className="inline-flex max-w-full items-center gap-1.5 text-ink underline-offset-2 hover:text-accent hover:underline"
                        title={image.clusterName ?? undefined}
                    >
                        <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                        <span className="truncate">{image.clusterName ?? '—'}</span>
                    </Link>
                </TableCell>

                <TableCell hideBelow="md" align="end" className="align-middle tabular-nums text-ink-secondary">
                    {image.containerCount.toLocaleString()}
                </TableCell>

                {/* The last OSV-mirror match — the findings' freshness — as on
                    the containers list; the SBOM's date is in the hover. */}
                <TableCell hideBelow="xl" className="truncate align-middle text-ink-muted">
                    {image.lastMatchedAt ? (
                        <span
                            title={`Advisories checked ${formatDate(image.lastMatchedAt)} · SBOM generated ${formatDate(image.scannedAt)}`}
                        >
                            {formatShortDate(image.lastMatchedAt)}
                        </span>
                    ) : image.scannedAt ? (
                        <span title={`SBOM generated ${formatDate(image.scannedAt)} · advisory check pending`}>
                            Pending
                        </span>
                    ) : (
                        <span>Not scanned</span>
                    )}
                </TableCell>

                <TableCell hideBelow="xl" align="end" className="align-middle tabular-nums text-ink-muted">
                    <span title={`First seen in this cluster ${formatDate(image.firstSeenAt)}`}>
                        {formatAge(image.firstSeenAt)}
                    </span>
                </TableCell>

                <TableCell hideBelow="xl" align="end" className="align-middle tabular-nums text-ink-muted">
                    {built ? (
                        <span title={`Built ${formatDate(built)}`}>{formatAge(built)}</span>
                    ) : (
                        <span title="No usable build date: the scanner did not report one, or the image carries a placeholder">
                            —
                        </span>
                    )}
                </TableCell>

                <TableCell align="end" className="whitespace-nowrap align-middle">
                    <RiskCell risk={image.risk} />
                </TableCell>

                <TableCell align="end" className="whitespace-nowrap align-middle">
                    <ContainerSeverityCell vulnerabilities={image.vulnerabilities} />
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow>
                    {/* Wider than the table at any breakpoint: a span past the
                        last column is clamped, so one number covers them all. */}
                    <TableCell colSpan={COLUMN_COUNT} className="bg-surface-muted">
                        <ImageContainers imageId={image.id} />
                    </TableCell>
                </TableRow>
            )}
        </>
    )
}

const COLUMN_COUNT = 9

/**
 * The containers running one image — `GET /api/images/:id/deployments`, the
 * image page's "Running in" table as a compact list. Every line is the same
 * image, so it carries no score: only where it runs and how it was asked for.
 */
function ImageContainers({ imageId }: { imageId: string }) {
    const { data, error, isLoading } = useResource<ImageDeployment[]>(`/api/images/${imageId}/deployments`, {
        fallbackError: 'Failed to fetch containers',
    })

    if (isLoading) return <LoadingBlock className="py-4" />
    if (error) return <p className="py-2 pl-7 text-xs text-danger">{error}</p>
    if (!data || data.length === 0) {
        return <p className="py-2 pl-7 text-xs text-ink-muted">No running container references this image any more.</p>
    }

    const sorted = [...data].sort(
        (a, b) =>
            a.namespaceName.localeCompare(b.namespaceName) ||
            a.workloadName.localeCompare(b.workloadName) ||
            a.containerName.localeCompare(b.containerName),
    )

    return (
        <ul className="py-1 pl-7" aria-label="Containers running this image">
            {sorted.map(d => {
                const tag = d.imageTag && !isDigestLikeTag(d.imageTag) ? d.imageTag : null
                return (
                    <li key={d.containerId} className="flex min-w-0 items-center gap-2 py-1">
                        <EntityIcon kind="container" className="size-3.5 text-ink-muted" />
                        <Link
                            href={`/clusters/${d.clusterId}/containers/${d.containerId}`}
                            className="min-w-0 truncate text-ink underline-offset-2 hover:text-accent hover:underline"
                            title={`${d.namespaceName} / ${d.workloadName} / ${d.containerName}`}
                        >
                            <span className="text-ink-muted">{d.namespaceName} / </span>
                            {d.workloadName}
                            {d.containerName !== d.workloadName && (
                                <span className="text-ink-muted"> / {d.containerName}</span>
                            )}
                        </Link>
                        {/* Null is "the scanner could not tell", never a kind of its own. */}
                        {d.workloadKind && <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">{d.workloadKind}</Badge>}
                        {d.init && <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">init</Badge>}
                        <span className="ml-auto shrink-0 whitespace-nowrap text-ink-muted">
                            {tag ? `:${tag}` : 'pinned by digest'}
                            {d.runningPods !== null && (
                                <>
                                    <span className="mx-1.5 text-ink-faint">·</span>
                                    {d.runningPods} {d.runningPods === 1 ? 'pod' : 'pods'}
                                </>
                            )}
                        </span>
                    </li>
                )
            })}
        </ul>
    )
}

/**
 * When the image was built — the `created` field of its config, as the
 * scanner reports it (0.4.0 and later) — or `null` when there is nothing
 * honest to show. Reproducible builds stamp a placeholder (1970, 1980), and
 * an age of fifty years would be a fact about the build tool, not the image;
 * anything before container images existed is treated as absent.
 */
const EARLIEST_BUILD = Date.UTC(2013, 0, 1)
function builtAt(image: Image): string | null {
    const created = image.metadata?.created
    if (!created) return null
    const time = new Date(created).getTime()
    return Number.isNaN(time) || time < EARLIEST_BUILD ? null : created
}

/**
 * The containers list's ordering rules, over images: unscanned sorts below
 * zero for risk and severity, and the name breaks every tie. The hook's
 * container-only column (`onImage`) falls through to the name.
 */
function compareImages(a: Image, b: Image, column: SortColumn | null, direction: SortDirection): number {
    const byName =
        (a.repository ?? '').localeCompare(b.repository ?? '') ||
        (a.clusterName ?? '').localeCompare(b.clusterName ?? '') ||
        a.digest.localeCompare(b.digest)
    const signed = (delta: number) => (direction === 'desc' ? -delta : delta)

    if (column === 'risk') {
        return signed((a.risk?.score ?? -1) - (b.risk?.score ?? -1)) || byName
    }
    if (column === 'severity') {
        return signed(severityScore(a.vulnerabilities) - severityScore(b.vulnerabilities)) || byName
    }
    if (column === 'scannedAt') {
        const at = new Date(a.lastMatchedAt ?? a.scannedAt ?? 0).getTime()
        const bt = new Date(b.lastMatchedAt ?? b.scannedAt ?? 0).getTime()
        return signed(at - bt) || byName
    }
    if (column === 'firstSeen') {
        return signed(new Date(a.firstSeenAt).getTime() - new Date(b.firstSeenAt).getTime()) || byName
    }
    if (column === 'built') {
        // No build date sorts last either way: unknown is neither old nor new.
        const ab = builtAt(a)
        const bb = builtAt(b)
        if (ab === null || bb === null) return ab === bb ? byName : ab === null ? 1 : -1
        return signed(new Date(ab).getTime() - new Date(bb).getTime()) || byName
    }
    return column === 'name' && direction === 'desc' ? -byName : byName
}

/** A scope menu's options: the distinct values, sorted, plus the chosen one if the rows no longer carry it. */
function scopeOptions(values: string[], chosen: string | null): { value: string; label: string }[] {
    const distinct = new Set(values)
    if (chosen !== null) distinct.add(chosen)
    return [...distinct].sort((a, b) => a.localeCompare(b)).map(value => ({ value, label: value }))
}

function plural(n: number, noun: string): string {
    return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

function NoImagesYet() {
    return (
        <div className="my-8 py-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-md bg-surface-muted ring-1 ring-edge">
                <ScanSearch className="size-7 text-ink-faint" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">No running images yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
                Images are discovered by the scanner running in a cluster. Once one reports, every
                image its containers run lands here.
            </p>
            <Link
                href="/clusters"
                className="mt-4 inline-flex text-sm text-accent underline-offset-2 hover:underline"
            >
                Go to clusters
            </Link>
        </div>
    )
}
