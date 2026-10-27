'use client';

import { Fragment, useState, useMemo } from 'react';
import { ChevronRight, Users, Layers, Server, Bug, AlertCircle, CheckCircle } from 'lucide-react';
import {
    Badge,
    VulnerabilityCounts,
    Table,
    TableContainer,
    TableHead,
    TableBody,
    TableFoot,
    TableHeader,
    SortableHeader,
    TableCell,
} from '@/components/ui';
import { ContainerGroupRow, ContainerRow, ContainersNoResults, ContainersToolbar } from '@/components/containers';
import type { SortColumn, SortDirection, Container } from '@/types/container';
import { getTotalVulnerabilities, groupContainers } from '@/utils/containerUtils';
import type { Cluster } from '@/types/cluster';
import { useResource } from '@/hooks';
import { PlanBadge, LoadingBox, formatMax } from './Shared';
import { formatTimeAgo } from './utils';
import type { RecentOrg } from './types';

/** One organization's detail screen: header stats, cluster grid, and a per-cluster container drill-down. */
export function AdminOrgDetail({ org, onBack }: { org: RecentOrg; onBack: () => void }) {
    const clustersResource = useResource<Cluster[]>(`/api/admin/organizations/${org.id}/clusters`, {
        cache: 'no-store',
        select: (body) => (body as { clusters?: Cluster[] }).clusters ?? [],
    });
    const containersResource = useResource<Container[]>(`/api/admin/organizations/${org.id}/containers`, {
        cache: 'no-store',
        select: (body) => (Array.isArray(body) ? (body as Container[]) : []),
    });
    const clusters = clustersResource.data;
    const allContainers = containersResource.data;
    const isLoading = clustersResource.isLoading || containersResource.isLoading;
    const error = clustersResource.error ?? containersResource.error;
    const [selectedCluster, setSelectedCluster] = useState<Cluster | null>(null);

    const orgVulnTotals = useMemo(
        () => (allContainers ? getTotalVulnerabilities(allContainers) : null),
        [allContainers],
    );

    if (isLoading) {
        return <LoadingBox />;
    }

    if (error) {
        return (
            <div className="rounded-md bg-danger-subtle border border-danger-muted p-6 flex items-start gap-3">
                <AlertCircle className="size-5 text-danger shrink-0 mt-0.5" />
                <p className="text-sm text-danger">{error}</p>
            </div>
        );
    }

    const { limits } = org;
    const hasVulns =
        orgVulnTotals && orgVulnTotals.critical + orgVulnTotals.high + orgVulnTotals.medium + orgVulnTotals.low > 0;

    return (
        <div>
            {/* Breadcrumb */}
            <nav className="text-sm text-ink-muted mb-6 flex flex-wrap items-center gap-1">
                <button type="button" onClick={onBack} className="hover:text-ink cursor-pointer">
                    Organizations
                </button>
                <ChevronRight className="size-3.5 text-ink-faint" />
                {selectedCluster ? (
                    <>
                        <button
                            type="button"
                            onClick={() => setSelectedCluster(null)}
                            className="hover:text-ink cursor-pointer"
                        >
                            {org.name}
                        </button>
                        <ChevronRight className="size-3.5 text-ink-faint" />
                        <span className="text-ink font-medium">{selectedCluster.name}</span>
                    </>
                ) : (
                    <span className="text-ink font-medium">{org.name}</span>
                )}
            </nav>

            {!selectedCluster ? (
                <>
                    {/* Org header + stats */}
                    <div className="mb-6 pb-6 border-b border-edge">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                            <h2 className="text-xl font-semibold text-ink">{org.name}</h2>
                            <PlanBadge plan={org.plan} status={org.stripeSubscriptionStatus} />
                            {org.demo && <Badge variant="info">demo</Badge>}
                        </div>
                        <p className="text-xs text-ink-muted font-mono break-all">
                            {org.slug} · Created {formatTimeAgo(org.createdAt)}
                        </p>

                        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div className="rounded-md border border-edge bg-surface-raised px-4 py-3">
                                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
                                    <Users className="size-3.5" /> Members
                                </p>
                                <p className="text-xl font-bold text-ink mt-0.5">{org.memberCount}</p>
                                <p className="text-xs text-ink-muted">/ {formatMax(limits.members)}</p>
                            </div>
                            <div className="rounded-md border border-edge bg-surface-raised px-4 py-3">
                                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
                                    <Layers className="size-3.5" /> SBOMs
                                </p>
                                <p className="text-xl font-bold text-ink mt-0.5">{org.sbomCount}</p>
                                <p className="text-xs text-ink-muted">/ {formatMax(limits.sboms)}</p>
                            </div>
                            <div className="rounded-md border border-edge bg-surface-raised px-4 py-3">
                                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
                                    <Server className="size-3.5" /> Clusters
                                </p>
                                <p className="text-xl font-bold text-ink mt-0.5">
                                    {clusters?.length ?? org.clusterCount}
                                </p>
                                <p className="text-xs text-ink-muted">/ {formatMax(limits.clusters)}</p>
                            </div>
                            <div className="rounded-md border border-edge bg-surface-raised px-4 py-3">
                                <p className="text-xs font-medium text-ink-muted uppercase tracking-wide flex items-center gap-1.5">
                                    <Bug className="size-3.5" /> Vulnerabilities
                                </p>
                                <div className="mt-1.5">
                                    {orgVulnTotals && hasVulns ? (
                                        <VulnerabilityCounts
                                            critical={orgVulnTotals.critical}
                                            high={orgVulnTotals.high}
                                            medium={orgVulnTotals.medium}
                                            low={orgVulnTotals.low}
                                            aggregated
                                        />
                                    ) : allContainers ? (
                                        <p className="text-xs text-success flex items-center gap-1">
                                            <CheckCircle className="size-3.5" /> None found
                                        </p>
                                    ) : (
                                        <p className="text-xs text-ink-muted">Loading…</p>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    <h3 className="text-sm font-semibold text-ink-secondary mb-3">Clusters</h3>

                    {clusters?.length === 0 ? (
                        <div className="rounded-md bg-surface-raised border border-edge p-8 text-center">
                            <Server className="size-8 text-ink-faint/70 mx-auto mb-2" />
                            <p className="text-sm text-ink-muted">No clusters in this organization.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                            {(clusters ?? []).map((cluster) => (
                                <button
                                    key={cluster.id}
                                    type="button"
                                    onClick={() => setSelectedCluster(cluster)}
                                    className="text-left rounded-md border border-edge bg-surface-raised p-4 hover:border-edge-strong hover:shadow-resting transition-all cursor-pointer"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="font-medium text-ink truncate">{cluster.name}</p>
                                            <p className="text-xs text-ink-muted font-mono mt-0.5 truncate">
                                                {cluster.id}
                                            </p>
                                        </div>
                                        <Server className="size-4 text-ink-faint shrink-0 mt-0.5" />
                                    </div>
                                    {cluster.scannerVersion && (
                                        <p className="text-xs text-ink-muted mt-2">Scanner v{cluster.scannerVersion}</p>
                                    )}
                                    <p className="text-xs text-ink-muted mt-1">
                                        {cluster.scannerLastSeenAt
                                            ? `Last seen ${formatTimeAgo(cluster.scannerLastSeenAt)}`
                                            : 'Scanner never connected'}
                                    </p>
                                </button>
                            ))}
                        </div>
                    )}
                </>
            ) : (
                /* Keyed on the cluster: the search box, the collapsed groups and
                   the sort belong to one cluster's list, and a remount is how
                   they reset when another is picked. */
                <ClusterContainersPanel
                    key={selectedCluster.id}
                    cluster={selectedCluster}
                    containers={(allContainers ?? []).filter((w) => w.clusterId === selectedCluster.id)}
                />
            )}
        </div>
    );
}

/** One cluster's containers, grouped by namespace, with the list's own search, fold and sort state. */
function ClusterContainersPanel({ cluster, containers }: { cluster: Cluster; containers: Container[] }) {
    const [searchValue, setSearchValue] = useState('');
    const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
    const [sortColumn, setSortColumn] = useState<SortColumn | null>(null);
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

    // Deduplicated by image — see `getTotalVulnerabilities`.
    const totalVulnerabilities = useMemo(() => getTotalVulnerabilities(containers), [containers]);

    const handleSort = (column: SortColumn) => {
        if (sortColumn === column) setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        else {
            setSortColumn(column);
            setSortDirection('asc');
        }
    };

    const toggleGroup = (key: string) => {
        setCollapsedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const groups = useMemo(() => {
        let filtered = containers;
        if (searchValue) {
            const q = searchValue.toLowerCase();
            filtered = containers.filter(
                (w) =>
                    w.workloadName.toLowerCase().includes(q) ||
                    w.name.toLowerCase().includes(q) ||
                    w.namespaceName.toLowerCase().includes(q) ||
                    (w.repository ?? '').toLowerCase().includes(q),
            );
        }

        const grouped = groupContainers(filtered);
        for (const group of grouped) {
            group.containers.sort((a, b) => {
                if (sortColumn === 'scannedAt') {
                    const at = a.scannedAt ? new Date(a.scannedAt).getTime() : 0;
                    const bt = b.scannedAt ? new Date(b.scannedAt).getTime() : 0;
                    return sortDirection === 'desc' ? bt - at : at - bt;
                }
                const byName = a.workloadName.localeCompare(b.workloadName) || a.name.localeCompare(b.name);
                return sortColumn === 'name' && sortDirection === 'desc' ? -byName : byName;
            });
        }
        return grouped;
    }, [containers, searchValue, sortColumn, sortDirection]);

    const matchCount = useMemo(() => groups.reduce((n, g) => n + g.containers.length, 0), [groups]);

    return (
        <>
            <div className="mb-4">
                <h2 className="text-lg font-semibold text-ink">{cluster.name}</h2>
                <p className="text-xs text-ink-muted font-mono break-all">{cluster.id}</p>
            </div>

            {containers.length > 0 && <ContainersToolbar searchValue={searchValue} onSearchChange={setSearchValue} />}

            {containers.length === 0 ? (
                <div className="rounded-md bg-surface-raised border border-edge p-8 text-center mt-4">
                    <Layers className="size-8 text-ink-faint/70 mx-auto mb-2" />
                    <p className="text-sm text-ink-muted">No containers in this cluster.</p>
                </div>
            ) : matchCount === 0 && searchValue ? (
                <ContainersNoResults />
            ) : (
                <TableContainer variant="card" square className="mt-4">
                    {/* Not `role="treegrid"` — see the note on the cluster containers page. */}
                    {/* Fixed layout + column widths mirror the cluster
                        containers page — the rows are shared, so the
                        columns (and their responsive collapse) must be
                        too: one header per cell `ContainerRow` renders
                        (name, image with the tag inline, checked, risk,
                        counts), and the Checked column collapses below
                        `md` exactly as the row's cell does. */}
                    <Table density="spacious" aria-label="Containers" className="relative w-full table-fixed">
                        <TableHead>
                            <SortableHeader
                                column="name"
                                sortColumn={sortColumn}
                                sortDirection={sortDirection}
                                onSort={handleSort}
                                className="md:w-1/3"
                            >
                                Container
                            </SortableHeader>
                            <TableHeader hideBelow="md">Image</TableHeader>
                            <SortableHeader
                                column="scannedAt"
                                sortColumn={sortColumn}
                                sortDirection={sortDirection}
                                onSort={handleSort}
                                hideBelow="md"
                                className="w-28"
                            >
                                Checked
                            </SortableHeader>
                            {/* ContainerRow renders a risk cell; without
                                this header every column after it sat
                                one slot off. */}
                            <TableHeader align="end" className="w-24">
                                Risk
                            </TableHeader>
                            <TableHeader align="end" className="w-52">
                                Vulnerabilities
                            </TableHeader>
                        </TableHead>
                        <TableBody>
                            {groups.map((group) => {
                                const isExpanded = Boolean(searchValue) || !collapsedKeys.has(group.key);
                                return (
                                    <Fragment key={group.key}>
                                        <ContainerGroupRow
                                            group={group}
                                            isExpanded={isExpanded}
                                            onToggle={() => toggleGroup(group.key)}
                                        />
                                        {isExpanded &&
                                            group.containers.map((container) => (
                                                <ContainerRow
                                                    key={container.id}
                                                    container={container}
                                                    depth={1}
                                                    onSelect={() => {}}
                                                />
                                            ))}
                                    </Fragment>
                                );
                            })}
                        </TableBody>
                        <TableFoot>
                            <TableCell className="font-semibold text-ink">Total</TableCell>
                            <TableCell hideBelow="md" />
                            <TableCell hideBelow="md" />
                            <TableCell colSpan={2} align="end" className="whitespace-nowrap">
                                <VulnerabilityCounts
                                    critical={totalVulnerabilities.critical}
                                    high={totalVulnerabilities.high}
                                    medium={totalVulnerabilities.medium}
                                    low={totalVulnerabilities.low}
                                    aggregated
                                />
                            </TableCell>
                        </TableFoot>
                    </Table>
                </TableContainer>
            )}
        </>
    );
}
