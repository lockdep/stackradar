'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowUp, ExternalLink, RefreshCw, TriangleAlert } from 'lucide-react';
import {
    Badge,
    EntityIcon,
    Button,
    RiskCell,
    LoadingBlock,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
import { ReleaseOccurrencesPopover, useCluster } from '@/components/clusters';
import { apiFetch, errorMessage } from '@/lib/api-client';
import type { Release, ReleasesResponse } from '@/types/container';

/**
 * The charts installed in one cluster.
 *
 * A list, not a fourth lens: the containers tab already groups *its* rows by
 * chart, and that answers "what is running under this chart". This answers the
 * inventory question instead — "what is installed here, at which version" —
 * which is the one you ask before you have a workload in mind, and which the
 * grouped list cannot answer for a release that deploys nothing the scanner
 * could see.
 *
 * The row unit is a **release**, not a chart name. One chart installed twice is
 * two things to upgrade, and collapsing them by name would merge two rows that
 * a `helm upgrade` has to touch separately — the same name collision the
 * `chartNameAmbiguous` flag exists to warn about.
 */
export function ClusterChartsView() {
    const { cluster } = useCluster();

    /* The fetch result carries the cluster it was for, so a switch to another
       cluster reads as "not loaded yet" without a synchronous
       `setIsLoading(true)` in the effect body — which is what
       `react-hooks/set-state-in-effect` forbids. Same arrangement as the tabs
       layout above. */
    const [fetched, setFetched] = useState<{
        id: string;
        data: ReleasesResponse | null;
        error: string | null;
    } | null>(null);
    const [isRefreshing, setIsRefreshing] = useState(false);

    const clusterId = cluster.id;

    const load = useCallback(
        (signal?: AbortSignal) =>
            apiFetch<ReleasesResponse>(`/api/releases?clusterId=${clusterId}`, { signal })
                .then((data) => setFetched({ id: clusterId, data, error: null }))
                .catch((err) => {
                    if (err instanceof DOMException && err.name === 'AbortError') return;
                    const error = errorMessage(err, 'Failed to load charts');
                    /* A failed *refresh* keeps the table it already drew. The
                       list on screen is still true as of the last successful
                       load, and replacing it with an error page would throw
                       away a correct answer over a transient one. */
                    setFetched((prev) => ({
                        id: clusterId,
                        data: prev?.id === clusterId ? prev.data : null,
                        error,
                    }));
                }),
        [clusterId],
    );

    useEffect(() => {
        const controller = new AbortController();
        load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const handleRefresh = () => {
        setIsRefreshing(true);
        load().finally(() => setIsRefreshing(false));
    };

    const current = fetched?.id === clusterId ? fetched : null;
    const data = current?.data ?? null;
    const error = current?.error ?? null;

    /* By chart, then by release. The server orders by release name because that
       is the release lens's key; under a tab called Charts the two installs of
       `redis` belong next to each other, and a null chart name sorts last —
       "the scanner could not read the label" is not a name beginning with a
       space. */
    const releases = useMemo(() => {
        if (!data) return [];
        return [...data.releases].sort((a, b) => {
            if (a.chartName !== b.chartName) {
                if (a.chartName === null) return 1;
                if (b.chartName === null) return -1;
                return a.chartName.localeCompare(b.chartName);
            }
            return a.name.localeCompare(b.name);
        });
    }, [data]);

    if (!current) {
        return <LoadingBlock label="Loading charts..." />;
    }

    if (error && !data) {
        return (
            <div className="flex flex-col items-center gap-3 py-24">
                <p className="text-sm font-medium text-ink">Failed to load charts</p>
                <p className="text-sm text-ink-muted">{error}</p>
                <Button variant="secondary" onClick={handleRefresh} loading={isRefreshing}>
                    <RefreshCw aria-hidden="true" className="size-3.5" />
                    Try again
                </Button>
            </div>
        );
    }

    return (
        <div className="mt-6">
            <div className="mb-3 flex items-end justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
                        <EntityIcon kind="chart" className="size-4 text-ink-muted" />
                        Charts
                        <Badge variant="neutral">{releases.length}</Badge>
                    </h2>
                    <p className="mt-1 text-sm text-ink-muted">
                        Helm releases the scanner found in {cluster.name}. One row per release — a chart installed twice
                        is two things to upgrade.
                    </p>
                </div>
                <Button
                    variant="secondary"
                    onClick={handleRefresh}
                    loading={isRefreshing}
                    title="Refresh charts"
                    className="shrink-0 pl-2 pr-2"
                >
                    {!isRefreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
                    <span className="sr-only">Refresh</span>
                </Button>
            </div>

            {/* The refresh failed but the table below is still the last good
                answer, so the banner says the list is stale rather than
                replacing it with an error page. */}
            {error && (
                <p className="mb-3 flex items-start gap-2 rounded-md border border-attention-muted bg-attention-subtle px-3 py-2 text-sm text-attention">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                    <span>Could not refresh — showing the last loaded list. {error}</span>
                </p>
            )}

            <TableContainer variant="section">
                <Table aria-label="Charts installed in this cluster">
                    <TableHead>
                        {/* The release name lives in the Chart cell rather than
                            a column of its own: `helm install cert-manager
                            jetstack/cert-manager` is the common case, so a
                            column that repeats the chart name on most rows
                            costs width and carries information on few. It is
                            printed whenever it differs, which is exactly when
                            it is worth reading. */}
                        <TableHeader>Chart</TableHeader>
                        {/* A phone gets the chart, its installed version and
                            the score — what is installed, at which version,
                            how bad. The namespace folds into the Chart cell
                            until its column is back; the counts and the app
                            version wait for the widest layouts, since both
                            are one click away on the release page. */}
                        <TableHeader>Chart version</TableHeader>
                        <TableHeader hideBelow="xl">App version</TableHeader>
                        <TableHeader hideBelow="md">Namespace</TableHeader>
                        <TableHeader hideBelow="lg" align="end">
                            Containers
                        </TableHeader>
                        <TableHeader hideBelow="xl" align="end">
                            Images
                        </TableHeader>
                        <TableHeader align="end">Risk Score</TableHeader>
                    </TableHead>
                    {releases.length === 0 ? (
                        <TableEmpty colSpan={7}>
                            No Helm releases detected in this cluster. Charts appear here once the scanner reports
                            containers carrying Helm&apos;s release metadata.
                        </TableEmpty>
                    ) : (
                        <TableBody>
                            {releases.map((release) => (
                                <ChartRow key={release.id} release={release} />
                            ))}
                        </TableBody>
                    )}
                </Table>
            </TableContainer>

            {/* Never hidden. A chart-grouped view that omits unmanaged containers
                under-reports the fleet invisibly — those rows have no group to
                be missing from. See the releases API. */}
            {data && data.unmanaged.containers > 0 && (
                <p className="mt-3 text-sm text-ink-muted">
                    {data.unmanaged.containers} {data.unmanaged.containers === 1 ? 'container' : 'containers'} in this
                    cluster
                    {data.unmanaged.containers === 1 ? ' is' : ' are'} not managed by any chart, so
                    {data.unmanaged.containers === 1 ? ' it is' : ' they are'} not listed here.
                </p>
            )}

            {/* The band the whole Artifact Hub column sits in, stated once. An
                index listing is not a measurement, and a row that shows a
                newer version must not be read as "and it fixes something". */}
            {releases.some((r) => r.artifactHub?.newerVersion) && (
                <p className="mt-1 flex items-center gap-1 text-sm text-ink-muted">
                    <ArrowUp aria-hidden="true" className="size-3 text-accent" />
                    marks a newer chart version Artifact Hub lists. Nothing here has scanned what it deploys — open a
                    release to see what an upgrade would move.
                </p>
            )}
        </div>
    );
}

/**
 * The Artifact Hub package this chart matched.
 *
 * Two states, and the badge has to keep them apart: with an observed `repoUrl`
 * the match is a **confirmation** — the repository the scanner read off the
 * cluster is the one the package publishes from. Without one it is the nightly
 * pass's **inference** from the version list, which is strong evidence and
 * still an inference, so it gets the dashed `muted` badge the rest of the app
 * uses for exactly that.
 */
function ArtifactHubLink({ hub, chartName }: { hub: NonNullable<Release['artifactHub']>; chartName: string | null }) {
    const title = hub.inferred
        ? `Matched on Artifact Hub: ${hub.repoName}/${chartName ?? ''} (${hub.repoUrl}). The scanner could not read this release's repository — the match is inferred from the installed version.`
        : `Matched on Artifact Hub: ${hub.repoName}/${chartName ?? ''} (${hub.repoUrl}), the repository the scanner observed.`;

    return (
        <a
            href={hub.url}
            target="_blank"
            rel="noreferrer noopener"
            title={title}
            className="shrink-0 rounded-sm hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
            <Badge variant={hub.inferred ? 'muted' : 'neutral'} className="gap-1">
                Artifact Hub
                <ExternalLink aria-hidden="true" className="size-3" />
            </Badge>
            <span className="sr-only">{hub.inferred ? ' (repository inferred)' : ''} — opens artifacthub.io</span>
        </a>
    );
}

function ChartRow({ release }: { release: Release }) {
    const hub = release.artifactHub ?? null;

    return (
        <TableRow hoverable>
            <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                    <Link
                        href={`/releases/${release.id}`}
                        className="inline-flex items-center gap-1.5 font-medium text-ink hover:text-accent hover:underline"
                    >
                        <EntityIcon kind="chart" />
                        {release.chartName ?? <span className="italic text-ink-muted">Unknown</span>}
                    </Link>
                    {/* Several repositories publish a chart called `nginx`.
                        Until a repo URL is known this row's name is a name
                        match, and the flag says so instead of implying the
                        releases are the same chart. */}
                    {release.chartNameAmbiguous && (
                        <>
                            <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0 text-attention" />
                            <span className="sr-only">
                                Another release uses this chart name from a repository we cannot prove is the same one.
                            </span>
                        </>
                    )}
                    {hub && <ArtifactHubLink hub={hub} chartName={release.chartName} />}
                    {/* Deprecation is the one thing on the row an upgrade
                        cannot fix, so it outranks the version note below. */}
                    {hub?.deprecated && (
                        <span title="Artifact Hub lists this chart as deprecated — newer versions may never come, and a maintained replacement is worth finding.">
                            <Badge variant="attention">deprecated</Badge>
                        </span>
                    )}
                </span>
                {/* Usually the same string as the chart — `helm install redis
                    bitnami/redis` — and printed only when it is not, which is
                    the case that matters: two installs of one chart are two
                    separate `helm upgrade`s. */}
                {release.name !== release.chartName && (
                    <div className="mt-0.5 text-xs text-ink-muted">
                        release <span className="text-ink-secondary">{release.name}</span>
                    </div>
                )}
                {/* The Namespace column, folded in while it is collapsed. */}
                <div className="mt-0.5 text-xs text-ink-muted md:hidden">
                    <span className="text-ink-secondary">{release.namespace}</span>
                    {release.namespaceCount > 1 && ` +${release.namespaceCount - 1}`}
                </div>
            </TableCell>
            <TableCell className="font-mono text-xs text-ink-secondary">
                {release.chartVersion ?? <span className="text-ink-muted">—</span>}
                {/* An Artifact Hub listing, not a measurement: nothing here has
                    scanned what that version deploys, so the row may say a
                    newer chart exists and nothing about what it fixes. */}
                {hub?.newerVersion && (
                    <div
                        className="mt-0.5 flex items-center gap-1 font-sans text-xs text-accent"
                        title={`Artifact Hub lists ${hub.newerVersion} for this chart. Nothing here has scanned what it deploys — open the release for the upgrade detail.`}
                    >
                        <ArrowUp aria-hidden="true" className="size-3" />
                        <span className="font-mono">{hub.newerVersion}</span>
                        <span className="sr-only">available on Artifact Hub</span>
                    </div>
                )}
            </TableCell>
            {/* The *application's* version, from `app.kubernetes.io/version` —
                not the chart's, even where the two are byte-identical. */}
            <TableCell hideBelow="xl" className="font-mono text-xs text-ink-secondary">
                {release.appVersion ?? <span className="text-ink-muted">—</span>}
            </TableCell>
            <TableCell hideBelow="md" className="text-ink-secondary">
                {release.namespace}
                {/* The release's own namespace. A chart may deploy into others,
                    and that count is the only hint on this row that it did. */}
                {release.namespaceCount > 1 && (
                    <span className="ml-2" title={`Its containers landed in ${release.namespaceCount} namespaces`}>
                        <Badge variant="neutral">+{release.namespaceCount - 1}</Badge>
                    </span>
                )}
            </TableCell>
            {/* Counts open to the things they count — same affordance as the
                Packages tab. A zero stays a plain number: "the scanner saw
                nothing under this release" has no list to show. */}
            <TableCell hideBelow="lg" align="end" className="tabular-nums text-ink-secondary">
                {release.containerCount > 0 ? (
                    <ReleaseOccurrencesPopover
                        releaseId={release.id}
                        label={release.chartName ?? release.name}
                        kind="containers"
                        count={release.containerCount}
                    />
                ) : (
                    <span className="text-ink-muted">0</span>
                )}
            </TableCell>
            <TableCell hideBelow="xl" align="end" className="tabular-nums text-ink-secondary">
                {release.imageCount > 0 ? (
                    <ReleaseOccurrencesPopover
                        releaseId={release.id}
                        label={release.chartName ?? release.name}
                        kind="images"
                        count={release.imageCount}
                    />
                ) : (
                    <span className="text-ink-muted">0</span>
                )}
            </TableCell>
            <TableCell align="end">
                <RiskCell risk={release.risk} />
            </TableCell>
        </TableRow>
    );
}
