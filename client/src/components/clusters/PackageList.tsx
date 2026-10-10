'use client'

import type { ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Boxes, RefreshCw, ShieldAlert, TriangleAlert } from 'lucide-react'
import {
    Badge,
    Button,
    FilterBar,
    FilterBarEnd,
    FilterBarRefresh,
    FilterBarReset,
    FilterMenu,
    ImagesFilterMenu,
    LoadingBlock,
    PackageTypeBadge,
    PaginationFooter,
    SearchInput,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    VulnerabilityCounts,
} from '@/components/ui'
import { KEV_PARAM, KevFilterButton, useKevFilter } from './KevFilter'
import { PackageOccurrencesPopover } from './PackageOccurrencesPopover'
import { SEVERITIES, SeverityFilterMenu, useSeverityFilter } from './SeverityFilter'
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider'
import { useRuntimeConfig } from '@/components/providers'
import { useControlFilter, usePagedResource, useResource } from '@/hooks'
import { CONTROL_FILTER_PARAM } from '@/lib/image-control'
import { ALL_ECOSYSTEMS, ECOSYSTEM_PARAM, ecosystemLabel } from '@/lib/package-ecosystem'
import { PAGE_SIZE } from '@/lib/constants'
import type { ClusterPackagesResponse } from '@/types/cluster'

type Props = {
    /**
     * The BFF list endpoint; `/occurrences` hangs off it.
     * `/api/clusters/:id/components` on a cluster tab, `/api/components` for
     * the organization — same parameters, same response.
     */
    apiBase: string
    /** Keys paging state: the cluster id, or the org id. */
    contextKey: string
    /**
     * Set on a cluster tab. Absent, the list is org-wide: rows gain a
     * Clusters column and the occurrence popovers name each hit's cluster.
     */
    clusterId?: string
    /** Whose scanned images the description says the packages span. */
    scopeLabel: ReactNode
    /** `h1` where the list is the page, `h2` inside a tab. */
    headingLevel: 'h1' | 'h2'
    /** `filtered` gets the search term — empty when only the menus narrow the list. */
    emptyText: { filtered: (search: string) => string; none: string }
    ariaLabel: string
    /** The search to open with — `?search=` from the Dashboard's box. */
    initialSearch?: string
}

/**
 * The distinct packages running in scope — every library of every scanned
 * image, one row per name + version. The cluster Packages tab and the
 * org-wide Packages page, which differ only in the endpoint they page over
 * and in whether a row needs to say which clusters it is in.
 *
 * Search and pagination are **server-side**, unlike the container detail page's
 * package list: that page filters one image's components in the browser, and
 * this one pages over a whole cluster or org, a set that reaches tens of
 * thousands of rows. Typing here changes the query, not a filter over rows we
 * happen to hold. `usePagedResource` owns that machinery — the debounce, the
 * scope-carrying offset and the keep-stale-rows-dimmed behaviour.
 *
 * The filters are the Dashboard's bar (`ui/FilterBar`) under the heading:
 * refresh, search, the ecosystem and the severity menu on the left — *which
 * rows* — and
 * whose images on the right, the vulnerability lists' menu with the same
 * meaning and the same `?control=`, so "npm packages in images we build" is
 * a link. The ecosystem options are the scope's own (`…/ecosystems`), read
 * off its purls, not a vocabulary. Severity is the vulnerability lists'
 * menu and `?severity=`, here meaning "has a finding in one of these bands"
 * — the row's own Vulnerabilities cell, so every listed row shows why it is
 * listed. "Known exploited" is a toggle beside it (`?kev=true`): has a
 * finding on the CISA KEV catalogue, the row's shield marker. Both set means
 * one finding that is both. They are the filters that cost a scan (the
 * scope's alias collapse), and only while one is set.
 *
 * Needs a Suspense boundary above it: the filters read the URL.
 */
export function PackageList({
    apiBase,
    contextKey,
    clusterId,
    scopeLabel,
    headingLevel,
    emptyText,
    ariaLabel,
    initialSearch,
}: Props) {
    const { control, setControl } = useControlFilter()
    /* The four bands only: a package row has no unscored count to match, so
       an `unscored` a pasted link carries is shown ticked and sends nothing. */
    const { filters, toggle } = useSeverityFilter()
    const severityValue = SEVERITIES.filter(s => filters.has(s)).join(',')
    const { organization } = useOrganization()
    const { demoMode } = useRuntimeConfig()
    const router = useRouter()
    const pathname = usePathname()
    const searchParams = useSearchParams()

    /* Any string the URL carries: the server treats one it cannot read as no
       filter, and the menu keeps a stale one listed so it can be cleared. */
    const ecosystem = searchParams.get(ECOSYSTEM_PARAM) || ALL_ECOSYSTEMS
    const setEcosystem = (next: string) => {
        const params = new URLSearchParams(searchParams.toString())
        if (next === ALL_ECOSYSTEMS) params.delete(ECOSYSTEM_PARAM)
        else params.set(ECOSYSTEM_PARAM, next)
        const query = params.toString()
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    }
    const { kevOnly, toggleKev } = useKevFilter()
    const ecosystems = useResource<{ ecosystems: string[] }>(`${apiBase}/ecosystems`)
    const {
        searchInput,
        setSearchInput,
        search,
        setOffset,
        data,
        error,
        isStale,
        isRefreshing,
        isLoaded,
        handleRefresh,
    } = usePagedResource<ClusterPackagesResponse>({
        contextKey,
        initialSearch,
        scope: `${control}|${ecosystem}|${severityValue}|${kevOnly}`,
        makeUrl: ({ limit, offset, search }) => {
            const params = new URLSearchParams({
                limit: String(limit),
                offset: String(offset),
            })
            if (search) params.set('search', search)
            if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control)
            if (ecosystem !== ALL_ECOSYSTEMS) params.set(ECOSYSTEM_PARAM, ecosystem)
            if (severityValue) params.set('severity', severityValue)
            if (kevOnly) params.set(KEV_PARAM, 'true')
            return `${apiBase}?${params}`
        },
        errorFallback: 'Failed to load packages',
    })

    if (!isLoaded) {
        return (
            <LoadingBlock label="Loading packages..." />
        )
    }

    if (error && !data) {
        return (
            <div className="flex flex-col items-center gap-3 py-24">
                <p className="text-sm font-medium text-ink">Failed to load packages</p>
                <p className="text-sm text-ink-muted">{error}</p>
                <Button variant="secondary" onClick={handleRefresh} loading={isRefreshing}>
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    Try again
                </Button>
            </div>
        )
    }

    const total = data?.total ?? 0
    const packages = data?.packages ?? []
    /* The range the *displayed* data covers — its own offset, not the pending
       query's, so the footer never claims a page that is still loading. */
    const shownOffset = data?.offset ?? 0
    const showClusters = !clusterId
    const Heading = headingLevel
    const columnCount = showClusters ? 7 : 6
    const isNarrowed = control !== 'all' || ecosystem !== ALL_ECOSYSTEMS || filters.size > 0 || kevOnly
    const canReset = searchInput !== '' || isNarrowed
    const listed = ecosystems.data?.ecosystems ?? []
    const ecosystemOptions = [
        { value: ALL_ECOSYSTEMS, label: 'All ecosystems' },
        ...(ecosystem === ALL_ECOSYSTEMS || listed.includes(ecosystem) ? listed : [ecosystem, ...listed]).map(value => ({
            value,
            label: ecosystemLabel(value),
        })),
    ]
    /* One URL write. The `?search=` a deep link arrived with goes too: the
       box is state once seeded, and a reload must not bring the term back. */
    const reset = () => {
        const params = new URLSearchParams(searchParams.toString())
        params.delete(CONTROL_FILTER_PARAM)
        params.delete(ECOSYSTEM_PARAM)
        params.delete('severity')
        params.delete(KEV_PARAM)
        params.delete('search')
        const query = params.toString()
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
        setSearchInput('')
    }

    return (
        <div>
            {/* The heading, then the filters as its bottom edge — the Dashboard's header. */}
            <div className="pb-4">
                <Heading
                    className={`flex items-center gap-2 font-semibold text-ink ${
                        headingLevel === 'h1' ? 'text-xl' : 'text-base'
                    }`}
                >
                    <Boxes aria-hidden="true" className="size-4 text-ink-muted" />
                    Packages
                    <Badge variant="neutral">{total.toLocaleString()}</Badge>
                    {isStale && <Spinner size="sm" className="text-ink-faint" />}
                </Heading>
                <p className="mt-1 text-sm text-ink-muted">
                    Every package in {scopeLabel}, one row per version.
                    {showClusters ? ' Image, container and cluster' : ' Image and container'} counts say
                    how widespread it is.
                </p>
            </div>

            <FilterBar label="Package filters — apply to the whole list">
                <FilterBarRefresh onRefresh={handleRefresh} isRefreshing={isRefreshing} label="Refresh packages" />
                <SearchInput
                    id="package-search"
                    label="Search packages"
                    placeholder="Search by name or purl"
                    value={searchInput}
                    onChange={setSearchInput}
                    className="w-full sm:w-64"
                />
                <FilterMenu
                    label="Ecosystem"
                    icon={<Boxes />}
                    value={ecosystem}
                    options={ecosystemOptions}
                    onChange={setEcosystem}
                    narrowed={ecosystem !== ALL_ECOSYSTEMS}
                />
                <SeverityFilterMenu filters={filters} onToggle={toggle} />
                <KevFilterButton active={kevOnly} onToggle={toggleKev} noun="packages with a vulnerability" />

                <FilterBarEnd>
                    {canReset && <FilterBarReset onReset={reset} />}
                    <ImagesFilterMenu
                        value={control}
                        onChange={setControl}
                        /* The tab's own gate: owners and admins, and the demo's read-only view. */
                        canManageImages={isAdminOrOwner(organization) || demoMode}
                    />
                </FilterBarEnd>
            </FilterBar>

            {error && (
                <p className="mb-3 flex items-start gap-2 rounded-md border border-attention-muted bg-attention-subtle px-3 py-2 text-sm text-attention">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>Could not refresh — showing the last loaded list. {error}</span>
                </p>
            )}

            <div className={isStale ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                <TableContainer variant="section">
                    <Table aria-label={ariaLabel} density="condensed">
                        <TableHead>
                            {/* A phone gets the package and its counts, with
                                the version folded under the name; the spread
                                columns return at `md`, license and clusters
                                at `lg`. */}
                            <TableHeader>Package</TableHeader>
                            <TableHeader hideBelow="sm">Version</TableHeader>
                            <TableHeader hideBelow="lg">License</TableHeader>
                            <TableHeader hideBelow="md" align="end">Images</TableHeader>
                            <TableHeader hideBelow="md" align="end">Containers</TableHeader>
                            {showClusters && <TableHeader hideBelow="lg" align="end">Clusters</TableHeader>}
                            <TableHeader align="end">Vulnerabilities</TableHeader>
                        </TableHead>
                        {packages.length === 0 ? (
                            <TableEmpty colSpan={columnCount}>
                                {search || isNarrowed ? emptyText.filtered(search) : emptyText.none}
                            </TableEmpty>
                        ) : (
                            <TableBody>
                                {packages.map(pkg => (
                                    <TableRow key={`${pkg.name}@${pkg.version ?? ''}`}>
                                        <TableCell>
                                            <span className="inline-flex flex-wrap items-center gap-1.5">
                                                <span
                                                    className="font-medium text-ink break-all"
                                                    title={pkg.purl ?? undefined}
                                                >
                                                    {pkg.name}
                                                </span>
                                                {pkg.packageType && (
                                                    <PackageTypeBadge packageType={pkg.packageType} />
                                                )}
                                            </span>
                                            {/* The Version column, folded in while it
                                                is collapsed — the row is one
                                                name + version, so it cannot go. */}
                                            {pkg.version && (
                                                <span className="mt-0.5 block font-mono text-xs text-ink-muted break-all sm:hidden">
                                                    {pkg.version}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell hideBelow="sm" className="font-mono text-xs text-ink-secondary">
                                            {pkg.version ?? <span className="text-ink-muted">—</span>}
                                        </TableCell>
                                        <TableCell hideBelow="lg" className="text-xs text-ink-secondary">
                                            {pkg.license ?? <span className="text-ink-muted">—</span>}
                                        </TableCell>
                                        <TableCell hideBelow="md" align="end" className="tabular-nums text-ink-secondary">
                                            <PackageOccurrencesPopover
                                                clusterId={clusterId}
                                                packageName={pkg.name}
                                                version={pkg.version}
                                                kind="images"
                                                control={control}
                                                count={pkg.imageCount}
                                            />
                                        </TableCell>
                                        <TableCell hideBelow="md" align="end" className="tabular-nums text-ink-secondary">
                                            {/* 0 is "scanned but not in any inventory yet",
                                                and a dash says "not running" less loudly
                                                than a zero says "you have a problem". */}
                                            {pkg.containerCount > 0 ? (
                                                <PackageOccurrencesPopover
                                                    clusterId={clusterId}
                                                    packageName={pkg.name}
                                                    version={pkg.version}
                                                    kind="containers"
                                                    control={control}
                                                    count={pkg.containerCount}
                                                />
                                            ) : (
                                                <span className="text-ink-muted">—</span>
                                            )}
                                        </TableCell>
                                        {showClusters && (
                                            <TableCell hideBelow="lg" align="end" className="tabular-nums text-ink-secondary">
                                                {/* No popover of its own: the image and
                                                    container popovers already name each
                                                    hit's cluster. */}
                                                <span title="Clusters with at least one image carrying this version">
                                                    {pkg.clusterCount}
                                                </span>
                                            </TableCell>
                                        )}
                                        <TableCell align="end">
                                            <span className="inline-flex items-center justify-end gap-1.5">
                                                {/* The aggregate risk chip's marker, with its meaning. */}
                                                {pkg.kevCount > 0 && (
                                                    <span
                                                        title={`${pkg.kevCount} confirmed exploited in the wild (CISA KEV)`}
                                                        className="inline-flex shrink-0 text-danger"
                                                    >
                                                        <ShieldAlert aria-hidden="true" className="size-3.5" />
                                                        <span className="sr-only">{pkg.kevCount} on CISA KEV</span>
                                                    </span>
                                                )}
                                                <VulnerabilityCounts {...pkg.vulnCounts} />
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        )}
                    </Table>
                </TableContainer>
            </div>

            <PaginationFooter
                total={total}
                pageSize={PAGE_SIZE}
                shownOffset={shownOffset}
                shownCount={packages.length}
                isStale={isStale}
                onOffsetChange={setOffset}
            />
        </div>
    )
}
