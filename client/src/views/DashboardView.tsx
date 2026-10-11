'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { BarChart3, Plus } from 'lucide-react';
import { ErrorBlock, LoadingBlock, MetricsChartCard, SeverityCards, Button } from '@/components/ui';
import { ClusterSummarySection } from '@/components/ClusterSummarySection';
import {
    ClustersAwaitingScanner,
    GettingStartedBanner,
    RegistryAuthBanner,
    ScannerUpdateBanner,
} from '@/components/clusters';
import { ScannerFeatureList } from '@/components/onboarding/ScannerFeatureList';
import { TryCliCard } from '@/components/onboarding/TryCliCard';
import {
    DashboardFilterBar,
    ImageOwnershipBanner,
    MostCritical,
    RecentMovement,
    indexFixes,
    mostCriticalUrl,
    movementUrl,
    type DashboardFilters,
} from '@/components/dashboard';
import { usePollWhile, useResource, useRevalidateOnFocus } from '@/hooks';
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { getPlanHistoryDays } from '@/components/organization-settings/constants';
import type { MetricsSnapshot } from '@/components/ui';
import type { Cluster } from '@/types/cluster';
import type { ClusterVulnerabilitiesResponse } from '@/types/cluster';
import type { Container } from '@/types/container';
import type { MovementResponse } from '@/types/feed';
import { CONTROL_FILTER_PARAM, matchesControlFilter } from '@/lib/image-control';
import { readStoredLens, resolveLens, storeLens, withTierParam } from '@/lib/tier-lens';
import type { FixesResponse } from '@/types/fixes';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api-client';

/* `useSyncExternalStore` wants a subscription; storage never notifies. */
const subscribeToNothing = () => () => {};

interface OrgMetricsSnapshot extends MetricsSnapshot {
    orgId: string;
}

/**
 * How often to re-check while clusters exist but have reported no containers.
 *
 * This polls `/api/containers`, which changes the moment the first SBOM is
 * ingested. Pointed at `org_metrics_snapshots` — as it was — it re-fetched a
 * table that only changes on the hour, so it spent requests and still looked
 * frozen for a mean of thirty minutes.
 */
const WAITING_POLL_MS = 15_000;

/* Snapshots are computed hourly, so a returning user only needs a refetch if
   they have been away long enough for a new one to plausibly exist. */
const METRICS_STALE_AFTER_MS = 5 * 60_000;

/**
 * Current state comes from live queries; snapshots only draw trends.
 *
 * Every number above the Trends block is summed from `/api/containers` — the same
 * rows the Clusters tab reads. The Dashboard used to answer "does this org have
 * any containers?" from `snapshots.at(-1)`, which is written by an hourly cron,
 * so a cluster that had been reporting for fifty minutes was told its scanner
 * had never connected. Never let the history store gate a question about now.
 */
export function DashboardView() {
    const router = useRouter();
    const { organization } = useOrganization();
    const { demoMode, edition } = useRuntimeConfig();
    /* The page's three filters, set in the bar under the title and carried by
       every block. Held in state, not the URL — the Dashboard's query string
       belongs to the severity cards' links. The images filter opens on All.
       The lens opens where every findings list opens: the reader's standing
       choice, else the organization's default (`useTierLens`, minus the URL).
       It used to open on All while the lists opened on the default, so the
       Critical card said 47 and the list a typed URL reached said 39 — same
       findings, two lenses, and nothing saying so. The cards' links still
       carry the lens they counted under. */
    const storedLens = useSyncExternalStore(subscribeToNothing, readStoredLens, () => null);
    const defaultLens = resolveLens(null, storedLens, organization?.defaultFindingTier ?? 'application');
    const defaults = useMemo<DashboardFilters>(() => ({ days: 30, control: 'all', lens: defaultLens }), [defaultLens]);
    const [chosen, setChosen] = useState<Partial<DashboardFilters>>({});
    const filters = useMemo(() => ({ ...defaults, ...chosen }), [defaults, chosen]);
    const { days, control, lens } = filters;
    const [isManualRefresh, setIsManualRefresh] = useState(false);
    const [snapshots, setSnapshots] = useState<OrgMetricsSnapshot[]>([]);
    const [containers, setContainers] = useState<Container[]>([]);
    const [clusters, setClusters] = useState<Cluster[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    /* Not shown. It is the reference the focus revalidator measures staleness
       against. */
    const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

    /* A plain `cancelled` flag per effect run was enough when the only trigger
       was a `days` change. Now the poll and the focus revalidator can fire while
       an earlier request is still open, so responses are matched against the
       latest request instead of merely the latest effect. */
    const requestId = useRef(0);

    /* History carries the page's filters like every live request: each
       snapshot records its counts per whose-image side and lens bucket, and
       the server sums the cells the filter selects. */
    const snapshotQuery = useMemo(() => {
        const params = new URLSearchParams({ days: String(days) });
        if (control !== 'all') params.set(CONTROL_FILTER_PARAM, control);
        return withTierParam(params, lens).toString();
    }, [days, control, lens]);

    const load = useCallback(
        async ({ silent = false } = {}) => {
            const id = ++requestId.current;
            if (!silent) setIsLoading(true);
            try {
                /* The live pair is what the page is about, so only these two can
               fail the page. Reversed — the way it was, with metrics hard and
               containers absent — a containers outage would render "no containers
               reported yet" over an org that has thousands. Trends are the only
               thing snapshots answer, and having none is a normal state to
               render: a failed metrics call costs the chart, not the page. */
                const [containerData, { clusters: clusterData }, snapshotData] = await Promise.all([
                    apiFetch<Container[]>('/api/containers'),
                    apiFetch<{ clusters: Cluster[] }>('/api/clusters'),
                    apiFetch<OrgMetricsSnapshot[]>(`/api/metrics/snapshots?${snapshotQuery}`).catch(() => null),
                ]);
                if (id !== requestId.current) return;
                setContainers(Array.isArray(containerData) ? containerData : []);
                setClusters(Array.isArray(clusterData) ? clusterData : []);
                if (snapshotData) setSnapshots(snapshotData);

                setLastUpdated(new Date());
                setError(null);
            } catch {
                /* A failed background poll leaves the last good render alone — the
               user did not ask for this request and shouldn't lose the page to it. */
                if (id === requestId.current && !silent) setError('Failed to load dashboard metrics');
            } finally {
                if (id === requestId.current) setIsLoading(false);
            }
        },
        [snapshotQuery],
    );

    /* Only the first load takes the page down to a spinner. A date-range
       change reloads under the rendered page: the filter bar the reader just
       used must not unmount from under them. */
    const hasLoaded = useRef(false);
    useEffect(() => {
        // Copied into the effect so the cleanup doesn't close over `.current`.
        const inFlight = requestId;
        void load({ silent: hasLoaded.current }).then(() => {
            hasLoaded.current = true;
        });
        // Discard in-flight responses on unmount or a window change.
        return () => {
            inFlight.current++;
        };
    }, [load]);

    const revalidate = useCallback(() => load({ silent: true }), [load]);

    /*
     * Severity totals, counted **once per image**.
     *
     * Findings are a property of a digest, so the same image running in twelve
     * namespaces contributes one set of findings. This is the definition
     * `metricsRepository.computeCurrentMetrics` uses for the trend chart a few
     * hundred pixels below, and the two disagreeing is the class of bug
     * `db/findings.ts` exists to prevent.
     *
     * `scanned` stays a *container* count, because it is the numerator of a
     * coverage ratio whose denominator is containers.
     */
    /* Whose images is answered in the browser for everything summed from the
       container rows — the severity cards' fallback and the Clusters list. */
    const scopedContainers = useMemo(
        () => (control === 'all' ? containers : containers.filter((w) => matchesControlFilter(w.control, control))),
        [containers, control],
    );

    const live = useMemo(() => {
        const severity = { critical: 0, high: 0, medium: 0, low: 0 };
        const countedImages = new Set<string>();
        let scanned = 0;
        for (const w of scopedContainers) {
            /* `vulnerabilities` is null until the image's first scan run
               completes, which is a different thing from "scanned, found
               nothing" — the severity block waits for the distinction rather
               than reporting four confident zeroes. */
            if (!w.vulnerabilities) continue;
            scanned++;
            if (countedImages.has(w.imageId)) continue;
            countedImages.add(w.imageId);
            severity.critical += w.vulnerabilities.critical;
            severity.high += w.vulnerabilities.high;
            severity.medium += w.vulnerabilities.medium;
            severity.low += w.vulnerabilities.low;
        }
        return { severity, scanned };
    }, [scopedContainers]);

    const hasContainers = containers.length > 0;
    const hasCluster = clusters.length > 0;
    const ready = !isLoading && !error;

    /* One condition per block, each naming the data that block actually needs.
       A single `showMetrics` gate is what hid the live components behind the
       hourly one. */
    /* `anyScanned` is over every image: a filter that matches nothing empties
       the blocks, it does not take them — or the bar — off the page. */
    const anyScanned = useMemo(() => containers.some((w) => w.vulnerabilities), [containers]);
    const showSeverity = ready && anyScanned;
    const showClusters = ready && hasCluster;
    /* Charts need a container to be about: an org registered an hour ago has
       snapshots that are all zeroes. One snapshot is enough to plot, though —
       it renders as a labelled point rather than being withheld. */
    const showTrends = ready && hasContainers && snapshots.length > 0;
    const isAwaitingScanner = ready && hasCluster && !hasContainers;
    /* The bar shows when anything it scopes does. */
    const showFilters = ready && hasContainers;

    /* The blocks are scoped and fetched here, not in the blocks: the filters
       are one choice for the page, so every request carries them. */
    const [includeLower, setIncludeLower] = useState(false);
    const movementFilters = useMemo(() => ({ days, control, lens, includeLower }), [days, control, lens, includeLower]);
    const movement = useResource<MovementResponse>(ready && hasContainers ? movementUrl(movementFilters) : null, {
        revalidateOnFocus: true,
        fallbackError: 'Could not load recent changes',
    });
    const mostCritical = useResource<ClusterVulnerabilitiesResponse>(
        showSeverity ? mostCriticalUrl({ lens, control }) : null,
        { revalidateOnFocus: true, fallbackError: 'Could not load the most critical vulnerabilities' },
    );

    /* The org's upgrade list: the fix each block names for an image or a
       chart. The slowest of the three reads, so everything that uses it
       renders without it first. */
    const fixes = useResource<FixesResponse>(showSeverity ? '/api/remediation/fixes' : null, {
        revalidateOnFocus: true,
        fallbackError: 'Failed to load the upgrade list',
    });
    const fixIndex = useMemo(() => indexFixes(fixes.data), [fixes.data]);

    /* The severity cards under the page's filters. The ranked list's response
       already counts every band per lens bucket, under the same image scope,
       so the cards and the list above them are one query's answer. The
       container rows carry no per-bucket split: they stand in only while that
       response is on its way, and only under "All findings", where the two
       are the same number (`db/findings.ts` defines both). */
    const lensedCounts = mostCritical.data?.severityTierCounts;
    const severityCounts = useMemo(() => {
        if (lensedCounts) {
            return {
                critical: lensedCounts.critical[lens],
                high: lensedCounts.high[lens],
                medium: lensedCounts.medium[lens],
                low: lensedCounts.low[lens],
            };
        }
        return lens === 'all' ? live.severity : null;
    }, [lensedCounts, lens, live.severity]);
    /* A filtered series starts where per-filter recording did — older
       snapshots carry no breakdown and the server leaves them out — so a
       narrowed page can have less history than the date range asks for, or
       none yet. Said once, over the blocks that draw it. */
    const isNarrowed = control !== 'all' || lens !== 'all';
    const filteredHistoryStart = useMemo(() => {
        if (!isNarrowed) return null;
        const first = snapshots[0];
        if (!first) return 'none' as const;
        const windowStart = Date.now() - days * 86_400_000;
        const startedAt = new Date(first.capturedAt);
        return startedAt.getTime() - windowStart > 86_400_000 ? startedAt : null;
    }, [isNarrowed, snapshots, days]);

    const { refetch: refetchMovement } = movement;
    const { refetch: refetchMostCritical } = mostCritical;
    const { refetch: refetchFixes } = fixes;
    const refreshAll = useCallback(async () => {
        setIsManualRefresh(true);
        try {
            await Promise.all([load({ silent: true }), refetchMovement(), refetchMostCritical(), refetchFixes()]);
        } finally {
            setIsManualRefresh(false);
        }
    }, [load, refetchMovement, refetchMostCritical, refetchFixes]);

    // Ends by itself: the first container row to appear clears `isAwaitingScanner`.
    usePollWhile(isAwaitingScanner, revalidate, WAITING_POLL_MS);
    useRevalidateOnFocus(revalidate, {
        lastUpdated,
        staleAfterMs: METRICS_STALE_AFTER_MS,
        // Don't race the first load, which has no `lastUpdated` to look stale against.
        enabled: !isLoading,
    });

    return (
        <div>
            <GettingStartedBanner
                hasCluster={hasCluster}
                hasContainers={hasContainers}
                isLoading={isLoading}
                canConnect={isAdminOrOwner(organization) && edition.multiCluster}
                onConnectCluster={() => router.push('/clusters')}
            />
            {/* Above the header, like the onboarding banner: a coverage gap
                that only an operator can close, and that every number below
                silently excludes. Links into the cluster's Coverage card, which
                carries the rows and the fix. */}
            {ready && <RegistryAuthBanner clusters={clusters} />}
            {ready && <ScannerUpdateBanner clusters={clusters} />}
            {/* The title, then the page's filters as its bottom edge: the bar's
                rule is the header's, so the filters read as belonging to the
                page and not to the first block under them. Without the bar
                (nothing to filter yet) the header keeps its own rule. */}
            <div className={showFilters ? 'pb-4' : 'mb-6 border-b border-edge pb-4'}>
                <h1 className="text-2xl font-bold text-ink">Dashboard</h1>
                <p className="mt-1 text-sm text-ink-muted">Live posture across every cluster in this organization.</p>
            </div>
            {showFilters && (
                <DashboardFilterBar
                    filters={filters}
                    defaults={defaults}
                    maxDays={getPlanHistoryDays(organization?.plan, edition)}
                    onChange={(next) => setChosen((prev) => ({ ...prev, ...next }))}
                    onRefresh={() => void refreshAll()}
                    isRefreshing={isManualRefresh}
                    /* The tab's own gate: owners and admins, and the demo's read-only view. */
                    canManageImages={isAdminOrOwner(organization) || demoMode}
                />
            )}

            {isLoading && <LoadingBlock label="Loading metrics..." />}

            {!isLoading && error && <ErrorBlock title={error} />}

            {/* Live posture first: what is in the cluster and what is wrong with
                it, answerable in one query at every point in the product's life.
                A 30-day line above it is built for the customer you have in
                month two, not the one deciding in minute two.

                Nothing else sits up here. The Radar Score, container and package
                totals are the Trends cards below, with history attached, and
                discovered-vs-scanned progress is the coverage line of the Clusters
                list at the bottom (per cluster, only while the two differ) or the
                awaiting-scanner card before the first SBOM lands. An org-wide
                line here repeated both. */}
            {/* Asked once, of owners and admins: which image repositories the
                org builds. It sharpens every recommendation below it, which is
                why it sits above them; it removes itself when nothing is
                unconfirmed. */}
            {organization && hasContainers && (
                <ImageOwnershipBanner orgId={organization.id} canManage={isAdminOrOwner(organization)} />
            )}

            {/* Each card deep-links into the org-wide Vulnerabilities page
                filtered to its severity — the same list the cluster Overview's
                cards open, over every cluster. */}
            {showSeverity && severityCounts && (
                <div>
                    <SeverityCards
                        snapshots={snapshots}
                        counts={severityCounts}
                        /* The list opens under the page's filters, so it lists what the card counted. */
                        severityHref={(severity) =>
                            `/vulnerabilities?severity=${severity}&tier=${lens}${control === 'all' ? '' : `&${CONTROL_FILTER_PARAM}=${control}`}`
                        }
                    />
                    {filteredHistoryStart && (
                        <p className="mt-2 text-xs text-ink-muted">
                            {filteredHistoryStart === 'none'
                                ? 'No history under these filters yet — it is recorded from the next hourly snapshot.'
                                : `History under these filters starts ${filteredHistoryStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, when per-filter recording began.`}
                        </p>
                    )}
                </div>
            )}

            {isAwaitingScanner && <ClustersAwaitingScanner clusters={clusters} />}

            {ready && !hasCluster && (
                <div className="mt-8 rounded-md border border-edge bg-surface-raised px-6 py-12 text-center">
                    <BarChart3 className="mx-auto size-12 text-ink-faint" />
                    <h3 className="mt-2 text-sm font-semibold text-ink">No metrics yet</h3>
                    {edition.multiCluster ? (
                        <>
                            <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto">
                                Connect a cluster and StackRadar will automatically discover your running containers,
                                generate SBOMs, and surface vulnerabilities — expect your first findings within minutes.
                            </p>
                            <ScannerFeatureList />
                            <div className="mt-6">
                                <Button variant="primary" onClick={() => router.push('/clusters')}>
                                    <Plus className="size-4" />
                                    Connect a cluster
                                </Button>
                            </div>
                        </>
                    ) : (
                        /* The community edition's cluster is made at start-up
                           from the server's bootstrap credential; with none
                           set there is nothing to connect, only to configure. */
                        <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto">
                            This install has no cluster configured. Set{' '}
                            <code className="font-mono text-xs">BOOTSTRAP_CLUSTER_ID</code> and{' '}
                            <code className="font-mono text-xs">BOOTSTRAP_CLUSTER_API_KEY</code> on the server and
                            restart it.
                        </p>
                    )}
                </div>
            )}
            {/* Under the pitch, not inside it: the no-install path for the
                user who skipped the onboarding gate and landed here. */}
            {ready && !hasCluster && edition.multiCluster && <TryCliCard className="mx-auto mt-4 max-w-xl" />}

            {/* Below the live block, and gated only on its own data. No
                "Last N days" caption: the filter bar already names the window in words, which is what lets the
                X axis go without a title. */}
            {showTrends && (
                <div className="mt-8 space-y-3">
                    <h2 className="text-sm font-semibold text-ink-secondary">Trends</h2>
                    {/* The same four cards, in the same order, as the cluster
                        Overview's Trends — the org page is that page folded over
                        every cluster, and the reader moves between the two.

                        The vulnerability total alone is a poor risk signal — it is
                        dominated by low and medium findings, so a fleet that clears
                        500 lows while picking up 10 criticals would read as an
                        improvement. The `criticalAndHigh` overlay puts the number
                        that actually matters on top of the volume that explains it. */}
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                        {/* The org-wide breakdown is behind this number, as a
                            cluster Overview's Radar Score tab is behind its. */}
                        <MetricsChartCard
                            title="Radar Score"
                            description="Sum of every finding's 0–100 contribution across all clusters"
                            dataKey="riskScore"
                            data={snapshots}
                            deltaDirection="up-bad"
                            href="/radar-score"
                            hrefTitle="See what drives the score"
                        />
                        {/* Unfiltered, unlike the severity cards above: this
                            number is every finding, so the link opens the whole
                            org-wide list. */}
                        <MetricsChartCard
                            title="Vulnerabilities"
                            description="Confirmed findings across all current SBOMs"
                            dataKey="totalVulnerabilities"
                            data={snapshots}
                            deltaDirection="up-bad"
                            overlay="criticalAndHigh"
                            href="/vulnerabilities"
                            hrefTitle="See all vulnerabilities"
                        />
                        {/* The org-wide Containers page is the surface behind
                            this number: every running container, worst first. */}
                        <MetricsChartCard
                            title="Running containers"
                            description="Containers running across all clusters"
                            dataKey="totalWorkloads"
                            data={snapshots}
                            href="/containers"
                            hrefTitle="See all containers"
                        />
                        {/* The org-wide Packages page is the surface behind
                            this number, as a cluster Overview's Packages tab
                            is behind its. */}
                        <MetricsChartCard
                            title="Packages"
                            description="Unique packages from all current SBOMs"
                            dataKey="totalComponents"
                            data={snapshots}
                            href="/packages"
                            hrefTitle="See all packages"
                        />
                    </div>
                </div>
            )}

            {/* Under the severity cards and the Trends: how much there is
                comes first, then what moved and what to look at first.

                What is new, before what to do first: the images already
                running that picked up findings this week — the in-app half
                of "you hear when it matters", the weekly digest being the
                other. */}

            <RecentMovement
                enabled={ready && hasContainers}
                data={movement.data}
                error={movement.error}
                isRefreshing={movement.isRefreshing}
                filters={movementFilters}
                onIncludeLowerChange={setIncludeLower}
                onShowEveryImage={() => setChosen((prev) => ({ ...prev, control: 'all' }))}
                fixIndex={fixIndex}
            />

            {/* What to look at first: the five
                advisories across every cluster the Vulnerabilities page
                ranks highest — by Radar Score — each unfolding to the images it affects.
                Gated on the same "at least one image scanned" the severity
                cards wait for. */}
            <MostCritical
                enabled={showSeverity}
                data={mostCritical.data}
                error={mostCritical.error}
                isRefreshing={mostCritical.isRefreshing}
                filters={{ lens, control }}
                onLensChange={(next) => {
                    /* Remembered like a list's choice: it is the same standing view. */
                    storeLens(next);
                    setChosen((prev) => ({ ...prev, lens: next }));
                }}
                onShowEveryImage={() => setChosen((prev) => ({ ...prev, control: 'all' }))}
                fixIndex={fixIndex}
                showClusterCount={clusters.length > 1}
            />

            {/* Last: the severity cards and the Trends are the org folded
                into one number each, and this
                is the same posture unfolded per cluster — the drill-down, so it
                reads after the summary it breaks down. Ranked worst-first; each
                row is the door to its cluster page. */}
            {showClusters && <ClusterSummarySection clusters={clusters} containers={scopedContainers} />}
        </div>
    );
}
