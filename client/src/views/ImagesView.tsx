'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ScanSearch } from 'lucide-react';
import {
    ContainerSeverityCell,
    ContainersCoverageStrip,
    ContainersError,
    ContainersLoading,
    useContainersView,
} from '@/components/containers';
import { ImageRow, ImagesCaption, ImagesToolbar, compareImages, scopeOptions } from '@/components/images';
import { useSetImageControl } from '@/components/image-control';
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { useResource } from '@/hooks';
import { controlFilterCounts, matchesControlFilter } from '@/lib/image-control';
import { TOTAL_RISK_HINT } from '@/lib/risk';
import type { Image, VulnerabilityCounts } from '@/types/container';
import {
    SortableHeader,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableFoot,
    TableHead,
    TableHeader,
} from '@/components/ui';

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
    const { organization } = useOrganization();
    const { demoMode } = useRuntimeConfig();
    const { data, error, isLoading, isRefreshing, refetch } = useResource<Image[]>('/api/images', {
        responseError: (_res, body) => (body as { error?: string }).error || 'Failed to fetch images',
        fallbackError: 'Failed to fetch images',
        revalidateOnFocus: true,
    });
    const images = useMemo(() => (data ?? []).filter((i) => i.containerCount > 0), [data]);

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
    } = useContainersView({ defaultSort: 'risk' });

    const [searchValue, setSearchValue] = useState('');

    /* Correcting a row's Organization / Third-party tag — owners and admins. */
    const { setControl: setImageControl, error: controlError } = useSetImageControl(refetch);

    /* Which rows are open — local state: an expansion is a glance, not a view
       worth a link. */
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
    const toggleExpanded = (id: string) =>
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    /* The rows name their own cluster, so the menu needs no second request —
       and lists only clusters that have an image to show. */
    const clusterOptions = useMemo(() => {
        const names = new Map<string, string>();
        for (const i of images) names.set(i.clusterId, i.clusterName ?? i.clusterId);
        return [...names].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    }, [images]);

    const inCluster = useMemo(
        () => (clusterId ? images.filter((i) => i.clusterId === clusterId) : images),
        [images, clusterId],
    );
    /* Namespace, then registry, each menu listing what the scope before it
       leaves — as on the containers list. An image matches a namespace when
       any container running it is there; a chosen value absent from the
       options (a stale link) stays listed so it can be seen and cleared. */
    const namespaceOptions = useMemo(
        () =>
            scopeOptions(
                inCluster.flatMap((i) => i.namespaces ?? []),
                namespace,
            ),
        [inCluster, namespace],
    );
    const inNamespace = useMemo(
        () => (namespace ? inCluster.filter((i) => i.namespaces?.includes(namespace)) : inCluster),
        [inCluster, namespace],
    );
    const registryOptions = useMemo(
        () =>
            scopeOptions(
                inNamespace.flatMap((i) => (i.registry ? [i.registry] : [])),
                registry,
            ),
        [inNamespace, registry],
    );
    const inRegistry = useMemo(
        () => (registry ? inNamespace.filter((i) => i.registry === registry) : inNamespace),
        [inNamespace, registry],
    );
    const controlCounts = useMemo(() => controlFilterCounts(inRegistry.map((i) => i.control)), [inRegistry]);
    const scoped = useMemo(
        () => inRegistry.filter((i) => matchesControlFilter(i.control, control)),
        [inRegistry, control],
    );

    /* Coverage of the chosen scope, before the unscanned toggle and the
       search — as on the containers list. */
    const coverage = useMemo(() => {
        let scanned = 0;
        for (const i of scoped) if (i.sbomId !== null) scanned++;
        return { scanned, unscanned: scoped.length - scanned };
    }, [scoped]);

    const rows = useMemo(() => {
        let filtered = scoped;
        if (filters.has('unscanned')) filtered = filtered.filter((i) => i.sbomId === null);
        if (searchValue) {
            const q = searchValue.toLowerCase();
            filtered = filtered.filter(
                (i) =>
                    (i.repository ?? '').toLowerCase().includes(q) ||
                    (i.registry ?? '').toLowerCase().includes(q) ||
                    i.digest.toLowerCase().includes(q) ||
                    (i.clusterName ?? '').toLowerCase().includes(q) ||
                    i.tags.some((t) => t.toLowerCase().includes(q)),
            );
        }
        return [...filtered].sort((a, b) => compareImages(a, b, sortColumn, sortDirection));
    }, [scoped, filters, searchValue, sortColumn, sortDirection]);

    /* A plain sum: every row is a distinct image, so there is nothing to
       deduplicate. `null` when no row has been scanned — never four zeroes. */
    const totals = useMemo(() => {
        let sum: VulnerabilityCounts | null = null;
        let containers = 0;
        for (const i of rows) {
            containers += i.containerCount;
            if (!i.vulnerabilities) continue;
            sum ??= { critical: 0, high: 0, medium: 0, low: 0 };
            sum.critical += i.vulnerabilities.critical;
            sum.high += i.vulnerabilities.high;
            sum.medium += i.vulnerabilities.medium;
            sum.low += i.vulnerabilities.low;
        }
        return { vulnerabilities: sum, containers };
    }, [rows]);

    const scopeActive = clusterId !== null || namespace !== null || registry !== null || control !== 'all';

    /* A different cluster usually has no namespace of the chosen name, so the
       param goes — unless it does. */
    const handleClusterChange = (id: string | null) => {
        const next = id ? images.filter((i) => i.clusterId === id) : images;
        const keepNamespace = namespace !== null && next.some((i) => i.namespaces?.includes(namespace));
        setCluster(id, { keepNamespace });
    };
    const narrowed = scopeActive || filters.size > 0 || Boolean(searchValue);

    const reset = () => {
        clearFilters();
        setSearchValue('');
    };

    return (
        <div>
            <ImagesToolbar
                hasImages={images.length > 0}
                refresh={{ onRefresh: refetch, isRefreshing }}
                search={{ value: searchValue, onChange: setSearchValue }}
                onReset={narrowed ? reset : null}
                scope={{
                    clusterId,
                    clusterOptions,
                    onClusterChange: handleClusterChange,
                    namespace,
                    namespaceOptions,
                    onNamespaceChange: setNamespace,
                    registry,
                    registryOptions,
                    onRegistryChange: setRegistry,
                }}
                control={{
                    value: control,
                    onChange: setControl,
                    counts: controlCounts,
                    canManage: isAdminOrOwner(organization) || demoMode,
                }}
            />

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
                    <ImagesCaption narrowed={narrowed} imageCount={rows.length} containerCount={totals.containers} />
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
                                    <span title="Whether your organization builds the image or someone else does">
                                        Image owner
                                    </span>
                                </TableHeader>
                                <TableHeader hideBelow="xl" className="w-40">
                                    Cluster
                                </TableHeader>
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
                                    <span title="How long ago this image first appeared in its cluster">
                                        First seen
                                    </span>
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
                                    <span title="How long ago the image was built, from the build date in the image itself">
                                        Built
                                    </span>
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
                                {rows.map((image) => (
                                    <ImageRow
                                        key={image.id}
                                        image={image}
                                        expanded={expanded.has(image.id)}
                                        onToggle={() => toggleExpanded(image.id)}
                                        onControlChange={
                                            setImageControl && image.repository
                                                ? (next) => void setImageControl(image, next)
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
    );
}

function NoImagesYet() {
    return (
        <div className="my-8 py-10 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-md bg-surface-muted ring-1 ring-edge">
                <ScanSearch className="size-7 text-ink-faint" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-ink">No running images yet</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
                Images are discovered by the scanner running in a cluster. Once one reports, every image its containers
                run lands here.
            </p>
            <Link href="/clusters" className="mt-4 inline-flex text-sm text-accent underline-offset-2 hover:underline">
                Go to clusters
            </Link>
        </div>
    );
}
