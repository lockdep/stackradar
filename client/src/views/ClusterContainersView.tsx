'use client';

import { controlFilterCounts, matchesControlFilter } from '@/lib/image-control';
import { Fragment, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
    Badge,
    EntityIcon,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableFoot,
    TableHead,
    TableHeader,
    SortableHeader,
} from '@/components/ui';
import {
    useContainersView,
    ContainerGroupRow,
    ContainerRow,
    ContainerSeverityCell,
    ContainersCoverageStrip,
    ContainersError,
    ContainersFilterBar,
    ContainersGroupingCaption,
    ContainersLoading,
    ContainersNoResults,
} from '@/components/containers';
import { ClusterEmptyState, useCluster, useClusterContainers } from '@/components/clusters';
import { useSetImageControl } from '@/components/image-control';
import { TOTAL_RISK_HINT } from '@/lib/risk';
import type { Container } from '@/types/container';
import { getScannedTotals, groupContainers, matchesFilters, sortGroups } from '@/utils/containerUtils';

/**
 * One cluster's Containers tab: every running container, grouped by
 * namespace, worst first. The org-wide `/containers` page is the same rows
 * without the fold (`ContainersView`); the row, filter bar, caption, coverage
 * strip and sort hook are shared between the two, never copied.
 *
 * `justInstalled` is the `?justInstalled=1` the connect wizard lands on, read
 * by the route and passed down so the view itself has no URL dependency.
 */
export function ClusterContainersView({ justInstalled }: { justInstalled: boolean }) {
    const router = useRouter();

    const { containers, error, isLoading, isRefreshing, handleRefresh } = useClusterContainers();
    /* Correcting a row's Organization / Third-party tag — owners and admins. */
    const { setControl: setImageControl, error: controlError } = useSetImageControl(handleRefresh);
    const { cluster } = useCluster();

    /* Ranking and filters live in the URL — a triaged view is the thing
       people paste at each other, and it does not survive a copied link from
       `useState`. Search stays local: it is a transient narrowing, and syncing
       it would put a router write on every keystroke. */
    const { sortColumn, sortDirection, filters, control, setControl, toggleSort, toggleFilter, clearFilters } =
        useContainersView();

    const [searchValue, setSearchValue] = useState('');
    const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());

    /* Deduplicated by image: five containers running one vulnerable base image
       are one thing to fix, and summing per row is what made the old total
       track container count rather than risk. Null when nothing in the cluster
       has been scanned — the footer says so rather than showing four zeroes. */
    const totals = useMemo(() => getScannedTotals(containers), [containers]);

    /* Coverage of the whole cluster, not of what survived the filters — a strip
       that shrank as you filtered by it would be answering a different question
       every time it was clicked. */
    const coverage = useMemo(() => {
        let scanned = 0;
        for (const w of containers) if (w.sbomId !== null) scanned++;
        return { scanned, unscanned: containers.length - scanned };
    }, [containers]);

    const handleSelect = (container: Container) => {
        router.push(`/clusters/${container.clusterId}/containers/${container.id}`);
    };

    const toggleGroup = (key: string) => {
        setCollapsedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    /*
     * Groups start expanded and are collapsed by exception, which is the
     * opposite of the old tree. A namespace is not a folder you opted into
     * creating — every container is inside one — so hiding them all behind a
     * closed chevron would hide the whole list.
     */
    const groups = useMemo(() => {
        // Whose images first: it is a scope, like the org page's cluster and namespace.
        let filtered = containers.filter((w) => matchesControlFilter(w.control, control));
        if (searchValue) {
            const q = searchValue.toLowerCase();
            filtered = filtered.filter(
                (w) =>
                    w.workloadName.toLowerCase().includes(q) ||
                    w.name.toLowerCase().includes(q) ||
                    w.namespaceName.toLowerCase().includes(q) ||
                    (w.repository ?? '').toLowerCase().includes(q) ||
                    (w.releaseName ?? '').toLowerCase().includes(q) ||
                    (w.chartName ?? '').toLowerCase().includes(q) ||
                    (w.applicationName ?? '').toLowerCase().includes(q),
            );
        }
        // Filters compose with search by intersection, so "3 of 47" falls out of
        // the caption's existing counts with no extra bookkeeping.
        if (filters.size > 0) filtered = filtered.filter((w) => matchesFilters(w, filters));

        const grouped = groupContainers(filtered);

        // Groups and rows both, or the top of the list is not the worst thing
        // in the cluster.
        return sortGroups(grouped, sortColumn, sortDirection);
    }, [containers, control, searchValue, filters, sortColumn, sortDirection]);

    const matchCount = useMemo(() => groups.reduce((n, g) => n + g.containers.length, 0), [groups]);

    /* Distinct images among the rows on screen. The caption prints it next to
       the container count because the two differ — the severity numbers are in
       images, and a total that is visibly smaller than the sum of the rows
       needs the reason stated somewhere the reader is already looking. */
    const imageCount = useMemo(() => new Set(groups.flatMap((g) => g.containers.map((w) => w.imageId))).size, [groups]);

    if (isLoading) return <ContainersLoading />;
    if (error) return <ContainersError error={error} onRetry={handleRefresh} />;

    const controlCounts = controlFilterCounts(containers.map((w) => w.control));
    const narrowed = Boolean(searchValue) || filters.size > 0 || control !== 'all';
    /* What Reset undoes: everything absent from a fresh link. The URL half is
       one write (`clearFilters`); the search box is local state. */
    const reset = () => {
        clearFilters();
        setSearchValue('');
    };

    return (
        <div className="mt-6">
            {/* The heading, then the filters as its bottom edge — the
                Vulnerabilities tab's header. The refresh lives in the bar: it
                reads `isRefreshing`, and a layout cannot read a child page's
                state. */}
            <div className="pb-4">
                <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                    <EntityIcon kind="container" className="size-4 text-ink-muted" />
                    Containers
                    <Badge variant="neutral">{containers.length.toLocaleString()}</Badge>
                </h2>
                <p className="mt-1 text-sm text-ink-muted">Every running container in {cluster.name}, by namespace.</p>
            </div>

            <ContainersFilterBar
                onRefresh={handleRefresh}
                isRefreshing={isRefreshing}
                search={containers.length > 0 ? { value: searchValue, onChange: setSearchValue } : undefined}
                control={control}
                onControlChange={setControl}
                controlCounts={controlCounts}
                onReset={narrowed ? reset : undefined}
            />

            {matchCount === 0 && (searchValue || filters.size > 0 || control !== 'all') ? (
                <ContainersNoResults
                    {...(filters.size > 0 || control !== 'all' ? { onClearFilters: clearFilters } : {})}
                />
            ) : containers.length === 0 ? (
                <ClusterEmptyState justInstalled={justInstalled} />
            ) : (
                <>
                    <ContainersGroupingCaption
                        groupCount={groups.length}
                        containerCount={matchCount}
                        imageCount={imageCount}
                        filtered={Boolean(searchValue) || filters.size > 0}
                    />
                    {controlError && (
                        <p role="alert" className="mt-3 text-xs text-danger">
                            Could not change the image&apos;s owner: {controlError}
                        </p>
                    )}
                    {/* `discoveredWorkloads: null` is "the scanner has never told
                        us", not "nothing is running". A 0%-coverage gauge there
                        would be a confident false statement about someone's
                        cluster, so the strip renders nothing instead. */}
                    <ContainersCoverageStrip
                        scanned={coverage.scanned}
                        unscanned={coverage.unscanned}
                        reported={cluster.discoveredWorkloads !== null}
                        active={filters.has('unscanned')}
                        onToggle={toggleFilter}
                    />
                    {/* A card, not the full-bleed section the sibling tabs use:
                        this is the one tab whose rows carry a tinted group
                        band, and on the page canvas that band and the canvas
                        are the same tone. Raised on its own white panel the
                        groups read as groups again. */}
                    <TableContainer variant="card" square className="mt-4">
                        {/* Not `role="treegrid"`: that role promises arrow-key
                            cell navigation this table doesn't implement. The
                            hierarchy is carried by `aria-level` and
                            `aria-expanded` on each row instead — both valid on
                            `role="row"` — which announces the structure without
                            over-promising the keyboard contract. */}
                        {/* `table-fixed`: the browser's auto layout sizes
                            columns to their widest nowrap cell, so one long
                            registry path put the whole tab into a horizontal
                            scroll. Fixed layout makes the header widths law
                            and the text columns truncate instead. */}
                        {/* Condensed and 12px: the list is scanned, not
                            read — a cluster of a few hundred containers
                            should fit on a screen or two. */}
                        <Table density="condensed" textSize="xs" aria-label="Containers" className="w-full table-fixed">
                            <TableHead>
                                <SortableHeader
                                    column="name"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    className="md:w-1/3"
                                >
                                    Container
                                </SortableHeader>
                                {/* Image takes whatever the fixed columns
                                    leave over, and carries the tag or
                                    digest inline — `repo:tag` is how an
                                    image ref is read everywhere else, and
                                    a separate column spent 8rem on the
                                    least-consulted fact in the row. The
                                    Checked column collapses below `md`
                                    before anything truncates into
                                    uselessness, and Image itself goes below
                                    `sm` — a phone shows the container, the
                                    score and the counts, which is the answer
                                    this list exists to give; those never
                                    collapse. `ContainerRow` hides the same
                                    cells (`checkedFrom="md"`), and
                                    `ContainerGroupRow` its spacers. */}
                                <TableHeader hideBelow="md">Image</TableHeader>
                                <TableHeader hideBelow="xl" className="w-32">
                                    <span title="Whether your organization builds the image or someone else does">
                                        Image owner
                                    </span>
                                </TableHeader>
                                <SortableHeader
                                    column="scannedAt"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    hideBelow="md"
                                    className="w-28"
                                >
                                    {/* "Checked", not "Scanned": the
                                        column shows the last advisory
                                        match, which recurs hourly —
                                        the one-off SBOM generation
                                        date is in the cell's hover. */}
                                    Checked
                                </SortableHeader>
                                {/* Risk before severity, and to its left.
                                    Severity orders by what a flaw would do if
                                    exploited; risk orders by that *times* how
                                    likely anyone is to exploit it, which is
                                    the question "what do I fix this week"
                                    actually asks. Both columns stay — the
                                    counts are what a report cites, and the
                                    score is what decides the order. */}
                                <SortableHeader
                                    column="risk"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    align="end"
                                    className="w-20 sm:w-24"
                                >
                                    {/* The one column whose meaning is not
                                        guessable from its name — "5,400" could
                                        be a count, a CVSS, a percentile. The
                                        hint says which, on hover, at the top. */}
                                    <span title={TOTAL_RISK_HINT}>Radar Score</span>
                                </SortableHeader>
                                {/* "Show me the worst one" is the question
                                    this product exists to answer, and until
                                    this header was sortable the user answered
                                    it by scanning the column with their eye. */}
                                <SortableHeader
                                    column="severity"
                                    sortColumn={sortColumn}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                    align="end"
                                    /* Four `w-10` squares plus the group
                                       rows' Σ prefix and cell padding — a
                                       step narrower on phones, where the
                                       padding is too. */
                                    className="w-48 sm:w-52"
                                >
                                    Vulnerabilities
                                </SortableHeader>
                            </TableHead>
                            <TableBody>
                                {groups.map((group) => {
                                    // Search reveals matches inside collapsed
                                    // groups; a hit the user cannot see reads
                                    // as no hit at all.
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
                                                        onSelect={handleSelect}
                                                        onControlChange={setImageControl}
                                                    />
                                                ))}
                                        </Fragment>
                                    );
                                })}
                            </TableBody>
                            <TableFoot>
                                {/* One cell per column, the collapsible ones
                                    hidden-matching, so the totals stay under
                                    the vulnerability column at every
                                    breakpoint. Only the score and count
                                    columns share a span: both are always
                                    visible. */}
                                <TableCell className="font-semibold text-ink">
                                    Total
                                    {/* Named, because a total that is not the
                                        sum of the rows above it looks like a
                                        bug unless it says why. */}
                                    <span className="ml-2 font-normal text-ink-muted">(per distinct image)</span>
                                </TableCell>
                                <TableCell hideBelow="md" />
                                <TableCell hideBelow="xl" />
                                <TableCell hideBelow="md" />
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
