'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Boxes, Container, Gauge, LayoutDashboard, Settings, ShieldAlert } from 'lucide-react';
import { SiHelm } from 'react-icons/si';
import { LoadingBlock, TabNav } from '@/components/ui';
import {
    ClusterProvider,
    ClusterContainersProvider,
    ScannerDot,
    ScannerUpdateBanner,
    getScannerHealth,
} from '@/components/clusters';
import { isAdminOrOwner, useOrganization } from '@/components/providers';
import { useNow, usePollWhile, useResource } from '@/hooks';
import type { Cluster } from '@/types/cluster';
import { formatRelativeTime } from '@/utils/formatters';

/**
 * How often to re-read the cluster while its scanner has not checked in
 * recently. Matches the containers provider below, so the header and the
 * container list learn about a freshly installed scanner on the same beat.
 */
const AWAITING_SCANNER_POLL_MS = 15_000;

/**
 * Owns everything the cluster tabs share: the cluster fetch, the header
 * and breadcrumb, and the tab strip.
 *
 * The `(tabs)` route group is load-bearing. A plain `[id]/layout.tsx` would
 * also wrap `containers/[containerId]`, painting the cluster tab strip above a
 * page that is not a cluster tab.
 */
export default function ClusterTabsLayout({ children }: { children: ReactNode }) {
    const { id } = useParams<{ id: string }>();
    /* Keyed on the id so a param change starts from a clean loading state
       instead of briefly showing the previous cluster's header. */
    return (
        <ClusterTabs key={id} id={id}>
            {children}
        </ClusterTabs>
    );
}

function ClusterTabs({ id, children }: { id: string; children: ReactNode }) {
    const router = useRouter();

    const {
        data: fetched,
        error,
        isLoading,
        refetch,
    } = useResource<Cluster>(`/api/clusters/${id}`, {
        select: (body) => (body as { cluster: Cluster }).cluster,
        fallbackError: 'Failed to load cluster',
        // Scanner health ages in the background; re-read it when the tab is looked at again.
        revalidateOnFocus: true,
    });

    /* A rename lands here and is layered over whatever the server says until the
       next fetch catches up — the settings form already saved it, so the
       header must not flicker back to the old name while a poll is in flight. */
    const [renamedTo, setRenamedTo] = useState<string | null>(null);
    const setClusterName = useCallback((name: string) => setRenamedTo(name), []);

    const cluster = useMemo<Cluster | null>(() => {
        if (!fetched) return null;
        return renamedTo !== null && renamedTo !== fetched.name ? { ...fetched, name: renamedTo } : fetched;
    }, [fetched, renamedTo]);

    const now = useNow();

    const health = useMemo(
        () => getScannerHealth(cluster?.scannerLastSeenAt ?? null),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `now` is the tick that makes the age re-derive
        [cluster?.scannerLastSeenAt, now],
    );

    /* A cluster whose scanner has not reported in the last few minutes is
       almost always one whose scanner is still being installed — the first
       heartbeat lands seconds after `helm install`. Polling until it does means
       "Waiting for scanner to connect" resolves itself rather than asking the user to
       reload. The first heartbeat flips `health` to active, which stops the
       interval; from then on focus-revalidation keeps the header honest. */
    usePollWhile(!isLoading && health !== 'active', refetch, AWAITING_SCANNER_POLL_MS);

    const clusterValue = useMemo(
        () => (cluster ? { cluster, setClusterName, refetchCluster: refetch } : null),
        [cluster, setClusterName, refetch],
    );

    const { organization } = useOrganization();

    const tabs = [
        { href: `/clusters/${id}`, name: 'Overview', icon: LayoutDashboard },
        { href: `/clusters/${id}/containers`, name: 'Containers', icon: Container },
        { href: `/clusters/${id}/risk-score`, name: 'Risk Score', icon: Gauge },
        { href: `/clusters/${id}/vulnerabilities`, name: 'Vulnerabilities', icon: ShieldAlert },
        { href: `/clusters/${id}/charts`, name: 'Charts', icon: SiHelm },
        { href: `/clusters/${id}/packages`, name: 'Packages', icon: Boxes },
        // Everything under Settings (rename, scanner key, delete) is
        // admin/owner-only on the server, so members don't get the tab —
        // same pattern as the Invites tab in Organization Settings.
        ...(isAdminOrOwner(organization)
            ? [{ href: `/clusters/${id}/settings`, name: 'Settings', icon: Settings }]
            : []),
    ];

    if (isLoading) {
        return <LoadingBlock />;
    }

    if (!cluster || !clusterValue) {
        return (
            <div className="flex items-center justify-center py-24">
                <div className="text-center">
                    <p className="text-sm font-medium text-ink">Failed to load cluster</p>
                    <p className="text-sm text-ink-muted mt-1">{error}</p>
                    <button
                        onClick={() => router.push('/clusters')}
                        className="mt-4 text-sm text-success hover:underline cursor-pointer"
                    >
                        Back to Clusters
                    </button>
                </div>
            </div>
        );
    }

    return (
        <ClusterProvider value={clusterValue}>
            <ClusterContainersProvider clusterId={cluster.id}>
                <div>
                    <ScannerUpdateBanner clusters={[cluster]} />
                    <div className="mb-6 border-b border-edge pb-4">
                        <nav aria-label="Breadcrumb" className="text-sm text-ink-muted mb-1">
                            <button
                                type="button"
                                onClick={() => router.push('/clusters')}
                                className="hover:text-ink cursor-pointer"
                            >
                                Clusters
                            </button>
                            <span className="mx-1.5 text-ink-faint">/</span>
                            <span className="text-ink font-medium">{cluster.name}</span>
                        </nav>
                        <h1 className="text-2xl font-bold text-ink">{cluster.name}</h1>
                        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
                            <span className="break-all">
                                Cluster ID: <span className="font-mono text-ink-secondary">{cluster.id}</span>
                            </span>
                            {cluster.kubernetesVersion && (
                                <>
                                    <span aria-hidden="true" className="text-ink-faint">
                                        ·
                                    </span>
                                    <span>
                                        Kubernetes{' '}
                                        <span className="font-mono text-ink-secondary">
                                            {cluster.kubernetesVersion}
                                        </span>
                                    </span>
                                </>
                            )}
                            {cluster.scannerVersion && (
                                <>
                                    <span aria-hidden="true" className="text-ink-faint">
                                        ·
                                    </span>
                                    <span>
                                        Scanner{' '}
                                        <span className="font-mono text-ink-secondary">{cluster.scannerVersion}</span>
                                    </span>
                                </>
                            )}
                            <span aria-hidden="true" className="text-ink-faint">
                                ·
                            </span>
                            <span className="flex items-center gap-1.5">
                                <ScannerDot health={health} />
                                {cluster.scannerLastSeenAt
                                    ? `Heartbeat ${formatRelativeTime(cluster.scannerLastSeenAt)}`
                                    : 'Waiting for scanner to connect'}
                            </span>
                        </p>
                    </div>

                    <TabNav items={tabs} label="Cluster sections" />

                    {children}
                </div>
            </ClusterContainersProvider>
        </ClusterProvider>
    );
}
