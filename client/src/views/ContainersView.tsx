'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ScanSearch, Server } from 'lucide-react'
import { Table, TableBody, TableCell, TableContainer, TableFoot, TableHead, TableHeader, SortableHeader } from '@/components/ui'
import {
    ContainerRow,
    ContainerSeverityCell,
    ContainersCoverageStrip,
    ContainersError,
    ContainersFilterBar,
    ContainersGroupingCaption,
    ContainersLoading,
    ContainersNoResults,
    useContainers,
    useContainersView,
} from '@/components/containers'
import { useSetImageControl } from '@/components/image-control'
import { useResource } from '@/hooks'
import { TOTAL_RISK_HINT } from '@/lib/risk'
import type { Cluster } from '@/types/cluster'
import type { Container } from '@/types/container'
import { controlFilterCounts, matchesControlFilter } from '@/lib/image-control'
import { compareContainers, getScannedTotals, matchesFilters } from '@/utils/containerUtils'

type ClusterName = Pick<Cluster, 'id' | 'name'>

/**
 * `/containers` — every running container in the organisation, in one flat
 * table, worst first.
 *
 * The cluster tab groups by namespace because a namespace is a fold of one
 * cluster. Org-wide the question is "what is the worst thing running
 * anywhere", and a namespace tree hides that behind alphabetical group
 * labels — so this page has Cluster and Namespace *columns* and no group
 * rows, and opens sorted by Radar Score. Five containers on one image tie at
 * the top, and that is correct: the same problem in five places. `/fixes` is
 * where it collapses into one move; here it is not deduplicated.
 *
 * The rows are the same `GET /api/containers` payload the Dashboard and the
 * cluster tab read (each narrows it in the browser), and the row, filter bar,
 * caption, coverage strip and sort hook are the cluster tab's — composed,
 * not copied, so the two container tables cannot drift apart.
 *
 * The cluster and namespace scope live in the URL (a filtered view is a link
 * people paste); search stays local state (a transient narrowing, and a
 * router write per keystroke is not acceptable).
 */
export function ContainersView() {
    const router = useRouter()
    const { containers, error, isLoading, isRefreshing, handleRefresh } = useContainers()
    /* Correcting a row's Organization / Third-party tag — owners and admins. */
    const { setControl: setImageControl, error: controlError } = useSetImageControl(handleRefresh)

    /* The names-only list, not `/api/clusters`: that one folds risk and
       coverage per cluster, which a column of names has no use for. `null`
       until it lands — the "no clusters" empty state waits for it rather
       than flashing on an empty default. */
    const { data: clusters } = useResource<ClusterName[]>('/api/clusters/names', {
        select: (body) => {
            const list = (body as { clusters?: unknown }).clusters
            return Array.isArray(list) ? (list as ClusterName[]) : []
        },
    })
    const clusterById = useMemo(() => {
        const map = new Map<string, ClusterName>()
        for (const c of clusters ?? []) map.set(c.id, c)
        return map
    }, [clusters])
    const clusterOptions = useMemo(
        () => [...(clusters ?? [])]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(c => ({ value: c.id, label: c.name })),
        [clusters],
    )

    const {
        sortColumn,
        sortDirection,
        filters,
        clusterId,
        namespace,
        control,
        setControl,
        toggleSort,
        toggleFilter,
        setCluster,
        setNamespace,
        clearFilters,
    } = useContainersView({ defaultSort: 'risk' })

    const [searchValue, setSearchValue] = useState('')

    /* The scope, in order: cluster, then namespace. The namespace options are
       the names among the rows the cluster filter leaves, so with a cluster
       chosen the menu lists that cluster's namespaces and with none it
       lists every name in the org — `default` across all clusters is a valid
       and useful view. */
    const inCluster = useMemo(
        () => (clusterId ? containers.filter(w => w.clusterId === clusterId) : containers),
        [containers, clusterId],
    )
    const namespaceOptions = useMemo(
        () => [...new Set(inCluster.map(w => w.namespaceName))]
            .sort((a, b) => a.localeCompare(b))
            .map(name => ({ value: name, label: name })),
        [inCluster],
    )
    const inNamespace = useMemo(
        () => (namespace ? inCluster.filter(w => w.namespaceName === namespace) : inCluster),
        [inCluster, namespace],
    )
    /* Whose images narrows inside the cluster and namespace scope, and its
       counts describe that scope — so an option's number is what choosing it
       will list. */
    const controlCounts = useMemo(() => controlFilterCounts(inNamespace.map(w => w.control)), [inNamespace])
    const scoped = useMemo(
        () => inNamespace.filter(w => matchesControlFilter(w.control, control)),
        [inNamespace, control],
    )

    /* Coverage of the chosen scope, before the unscanned toggle and the
       search: "12/47 scanned" describes the scope the reader picked, and
       clicking it reveals exactly the missing rows in that scope. */
    const coverage = useMemo(() => {
        let scanned = 0
        for (const w of scoped) if (w.sbomId !== null) scanned++
        return { scanned, unscanned: scoped.length - scanned }
    }, [scoped])

    const rows = useMemo(() => {
        let filtered = scoped
        if (filters.size > 0) filtered = filtered.filter(w => matchesFilters(w, filters))
        if (searchValue) {
            const q = searchValue.toLowerCase()
            filtered = filtered.filter(w =>
                w.workloadName.toLowerCase().includes(q) ||
                w.name.toLowerCase().includes(q) ||
                w.namespaceName.toLowerCase().includes(q) ||
                (w.repository ?? '').toLowerCase().includes(q) ||
                (w.releaseName ?? '').toLowerCase().includes(q) ||
                (w.chartName ?? '').toLowerCase().includes(q) ||
                (w.applicationName ?? '').toLowerCase().includes(q),
            )
        }
        return [...filtered].sort((a, b) => compareContainers(a, b, sortColumn, sortDirection))
    }, [scoped, filters, searchValue, sortColumn, sortDirection])

    /* Deduplicated by image, like the cluster tab's footer: five containers on
       one vulnerable base image are one thing to fix. Over the rows on screen,
       so a scoped view's total is that scope's. */
    const totals = useMemo(() => getScannedTotals(rows), [rows])
    const imageCount = useMemo(() => new Set(rows.map(w => w.imageId)).size, [rows])

    const scopeActive = clusterId !== null || namespace !== null || control !== 'all'
    const narrowed = scopeActive || filters.size > 0 || Boolean(searchValue)

    const handleSelect = (container: Container) => {
        router.push(`/clusters/${container.clusterId}/containers/${container.id}`)
    }

    /* A different cluster usually has no namespace of the chosen name, so the
       param goes — unless it does, in which case the reader's choice stands. */
    const handleClusterChange = (id: string | null) => {
        const next = id ? containers.filter(w => w.clusterId === id) : containers
        const keepNamespace = namespace !== null && next.some(w => w.namespaceName === namespace)
        setCluster(id, { keepNamespace })
    }

    /* What Reset undoes: everything absent from a fresh link. The URL half is
       one write (`clearFilters`); the search box is local state. */
    const reset = () => {
        clearFilters()
        setSearchValue('')
    }

    /* With one namespace there is nothing to choose; with a stale
       `?namespace=` the menu stays, and lists it, so the reader can see and
       clear it. */
    const showNamespaces = namespaceOptions.length > 1 || namespace !== null
    const namespaceMenuOptions =
        namespace !== null && !namespaceOptions.some(o => o.value === namespace)
            ? [...namespaceOptions, { value: namespace, label: namespace }]
            : namespaceOptions

    return (
        <div>
            {/* The heading, then the filters as its bottom edge — the Dashboard's header. */}
            <header className="pb-4">
                <h1 className="text-xl font-semibold text-ink">Containers</h1>
                <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                    Every running container across your clusters, worst first. Findings belong to
                    the image a container runs; two containers on the same image show the same score.
                </p>
            </header>

            {/* Before the first container there is nothing to filter, and the
                bar is the refresh alone — the one control an empty page needs. */}
            <ContainersFilterBar
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing}
                search={containers.length > 0 ? { value: searchValue, onChange: setSearchValue } : undefined}
                /* Shown even with one cluster: "All clusters" is what tells
                   the reader the scope, as the Feed does. */
                cluster={
                    clusterOptions.length > 0
                        ? { value: clusterId, options: clusterOptions, onChange: handleClusterChange }
                        : undefined
                }
                namespace={
                    showNamespaces
                        ? { value: namespace, options: namespaceMenuOptions, onChange: setNamespace }
                        : undefined
                }
                control={control}
                onControlChange={setControl}
                controlCounts={controlCounts}
                onReset={narrowed ? reset : undefined}
            />

            <div>
                {isLoading ? (
                    <ContainersLoading label="Loading containers..." />
                ) : error ? (
                    <ContainersError error={error} onRetry={handleRefresh} />
                ) : clusters && clusters.length === 0 ? (
                    <NoClusters />
                ) : containers.length === 0 ? (
                    <NoContainersYet />
                ) : (
                    <>
                        {rows.length === 0 ? (
                            <ContainersNoResults
                                {...(scopeActive || filters.size > 0 ? { onClearFilters: clearFilters } : {})}
                            />
                        ) : (
                            <>
                                <ContainersGroupingCaption
                                    grouping="flat"
                                    containerCount={rows.length}
                                    imageCount={imageCount}
                                    filtered={narrowed}
                                />
                                {/* `reported` is "some scanner has sent an inventory":
                                    the rows exist, so one has. The per-cluster
                                    `discoveredWorkloads` guard has no org-wide twin. */}
                                {controlError && (
                                    <p role="alert" className="mt-3 text-xs text-danger">
                                        Could not change the image&apos;s owner: {controlError}
                                    </p>
                                )}
                                <ContainersCoverageStrip
                                    scanned={coverage.scanned}
                                    unscanned={coverage.unscanned}
                                    reported={containers.length > 0}
                                    active={filters.has('unscanned')}
                                    onToggle={toggleFilter}
                                />
                                <TableContainer variant="card" square className="mt-4">
                                    {/* `table-fixed`: header widths are law and the
                                        text columns truncate — see the cluster tab.
                                        The columns read as a k9s or Lens pods
                                        list — name, namespace, controlled by,
                                        pods, age — because that is the list a
                                        Kubernetes reader already knows; the rows
                                        stay containers. Cluster, Namespace,
                                        Controlled by, Pods and Checked all collapse
                                        below `xl`: three narrow columns on top of the
                                        tab's four leave the Image column nothing at
                                        `lg`, where the fixed sidebar has just taken
                                        288px. Image goes below `sm` (the row folds
                                        cluster and namespace under the name there).
                                        Risk and the counts never collapse. */}
                                    <Table
                                        density="condensed"
                                        textSize="xs"
                                        aria-label="Containers across all clusters"
                                        className="w-full table-fixed"
                                    >
                                        <TableHead>
                                            {/* No width below `md`: with Image gone the
                                                name is the only flexible column and
                                                takes what the score and the squares
                                                leave. */}
                                            <SortableHeader
                                                column="name"
                                                sortColumn={sortColumn}
                                                sortDirection={sortDirection}
                                                onSort={toggleSort}
                                                /* A step narrower from `xl`: the kind
                                                   badge has left for its own column. */
                                                className="md:w-1/4 xl:w-1/5"
                                            >
                                                Name
                                            </SortableHeader>
                                            <TableHeader hideBelow="xl" className="w-32">Cluster</TableHeader>
                                            <TableHeader hideBelow="xl" className="w-28">Namespace</TableHeader>
                                            <TableHeader hideBelow="xl" className="w-28">Controlled by</TableHeader>
                                            <TableHeader hideBelow="xl" align="end" className="w-14">
                                                <span title="Pods observed running this container on this image">Pods</span>
                                            </TableHeader>
                                            <TableHeader hideBelow="md">Image</TableHeader>
                                            <TableHeader hideBelow="xl" className="w-32">
                                                <span title="Whether your organization builds the image or someone else does">Image owner</span>
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
                                                column="onImage"
                                                sortColumn={sortColumn}
                                                sortDirection={sortDirection}
                                                onSort={toggleSort}
                                                hideBelow="xl"
                                                align="end"
                                                className="w-20"
                                            >
                                                {/* Lens's Age, which a rollout also resets. */}
                                                <span title="How long the container has run this exact image. Exposure across earlier images is on the container's page.">
                                                    Age
                                                </span>
                                            </SortableHeader>
                                            <SortableHeader
                                                column="risk"
                                                sortColumn={sortColumn}
                                                sortDirection={sortDirection}
                                                onSort={toggleSort}
                                                align="end"
                                                /* A step narrower on phones: the
                                                   score is four digits and a KEV
                                                   mark, and every 16px here is
                                                   16px off the container name. */
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
                                                /* Four `w-10` squares plus cell padding —
                                                   no group rows here, so no Σ prefix. */
                                                className="w-44"
                                            >
                                                Vulnerabilities
                                            </SortableHeader>
                                        </TableHead>
                                        <TableBody>
                                            {rows.map(container => (
                                                <ContainerRow
                                                    key={container.id}
                                                    container={container}
                                                    depth={0}
                                                    onSelect={handleSelect}
                                                    cluster={clusterById.get(container.clusterId) ?? null}
                                                    showNamespace
                                                    checkedFrom="xl"
                                                    showOnImage
                                                    showController
                                                    onControlChange={setImageControl}
                                                />
                                            ))}
                                        </TableBody>
                                        <TableFoot>
                                            {/* One cell per column, the collapsible ones
                                                hidden-matching, so the totals stay under
                                                the last column at every breakpoint. */}
                                            <TableCell className="font-semibold text-ink">
                                                Total
                                                <span className="ml-2 hidden font-normal text-ink-muted sm:inline">
                                                    (per distinct image)
                                                </span>
                                            </TableCell>
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="md" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell hideBelow="xl" />
                                            <TableCell colSpan={2} align="end" className="whitespace-nowrap">
                                                <ContainerSeverityCell
                                                    vulnerabilities={totals.vulnerabilities}
                                                    aggregated
                                                />
                                            </TableCell>
                                        </TableFoot>
                                    </Table>
                                </TableContainer>
                            </>
                        )}
                    </>
                )}
            </div>
        </div>
    )
}

/**
 * The two org-wide empty states. Neither is `ContainersEmpty`, which is the
 * per-cluster install panel and needs a cluster to talk about.
 */
function NoClusters() {
    return (
        <div className="my-8 py-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-md bg-surface-muted ring-1 ring-edge">
                <Server className="size-7 text-ink-faint" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">No clusters connected</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
                Containers are discovered by the scanner running in a cluster. Connect one and
                its running containers will appear here.
            </p>
            <Link
                href="/clusters"
                className="mt-4 inline-flex text-sm text-accent underline-offset-2 hover:underline"
            >
                Connect a cluster
            </Link>
        </div>
    )
}

function NoContainersYet() {
    return (
        <div className="my-8 py-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-md bg-surface-muted ring-1 ring-edge">
                <ScanSearch className="size-7 text-ink-faint" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">Waiting for the first containers</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
                No scanner has reported yet. Once one does, every running container it finds lands
                here — check the cluster page for its install command and status.
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
