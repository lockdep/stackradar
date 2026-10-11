'use client';

import { useMemo, useState } from 'react';
import { Plus, RefreshCw, Server } from 'lucide-react';
import { Button, ErrorBlock, LoadingBlock, RelativeTime } from '@/components/ui';
import type { Cluster } from '@/types/cluster';
import { ClusterTable, GettingStartedBanner, NewClusterDialog, useClusters } from '@/components/clusters';
import { ScannerFeatureList } from '@/components/onboarding/ScannerFeatureList';
import { TryCliCard } from '@/components/onboarding/TryCliCard';
import { isAdminOrOwner, useOrganization } from '@/components/providers/OrganizationProvider';
import { useRuntimeConfig } from '@/components/providers';
import { PLAN_LIMITS, effectivePlan, planName } from '@/components/organization-settings/constants';
import { useRouter } from 'next/navigation';
import { useResource } from '@/hooks';

export default function ClustersPage() {
    const router = useRouter();
    const { clusters, error, isLoading, isRefreshing, lastUpdated, handleRefresh, createCluster } = useClusters();

    const [isNewDialogOpen, setIsNewDialogOpen] = useState(false);

    // Over-limit happens on downgrade: existing clusters keep working (only
    // creation is gated), so nothing else on this page would reveal it.
    // Unknown plan values fall back to free, matching the server.
    const { organization } = useOrganization();
    const { edition } = useRuntimeConfig();
    // Cluster creation is admin/owner-only on the server; members get no
    // dead buttons that would only 403. In the community edition nobody
    // connects a cluster from here: the one cluster is the install's own,
    // created at start-up, so the control is absent for every role.
    const canManageClusters = isAdminOrOwner(organization) && edition.multiCluster;
    const planLimits = PLAN_LIMITS[effectivePlan(organization?.plan, edition)];
    const currentPlanName = planName(organization?.plan, edition);
    const isOverClusterLimit = clusters.length > planLimits.clusters;

    /* Soft-fail: a failed load leaves `data` null and the card simply omits
       the container count. Re-read when the cluster list changes length — a
       new or deleted cluster moves rows between buckets. */
    const { data: containerRows } = useResource<{ clusterId: string }[]>('/api/containers', {
        refreshKey: clusters.length,
        select: (body) => (Array.isArray(body) ? (body as { clusterId: string }[]) : []),
    });
    const workloadCountsByCluster = useMemo(() => {
        if (!containerRows) return null;
        /* No `type` filter any more: every row is a running container,
           and a namespace is a separate table rather than a row that
           had to be filtered out of its own list. */
        const counts: Record<string, number> = {};
        for (const w of containerRows) {
            counts[w.clusterId] = (counts[w.clusterId] ?? 0) + 1;
        }
        return counts;
    }, [containerRows]);

    if (isLoading) {
        return (
            <div>
                <div className="mb-6 border-b border-edge pb-4">
                    <h1 className="text-2xl font-bold text-ink">Clusters</h1>
                </div>
                <LoadingBlock label="Loading clusters..." />
            </div>
        );
    }

    if (error) {
        return (
            <div>
                <div className="mb-6 border-b border-edge pb-4">
                    <h1 className="text-2xl font-bold text-ink">Clusters</h1>
                </div>
                <ErrorBlock title="Failed to load clusters" message={error} onRetry={handleRefresh} />
            </div>
        );
    }

    const hasContainers = workloadCountsByCluster !== null && Object.values(workloadCountsByCluster).some((n) => n > 0);

    return (
        <div>
            <GettingStartedBanner
                hasCluster={clusters.length > 0}
                hasContainers={hasContainers}
                isLoading={workloadCountsByCluster === null}
                canConnect={canManageClusters}
                onConnectCluster={() => setIsNewDialogOpen(true)}
            />
            <div className="mb-6 flex flex-col gap-3 border-b border-edge pb-4 sm:flex-row sm:items-center sm:justify-between">
                <h1 className="text-2xl font-bold text-ink">Clusters</h1>
                <div className="flex flex-wrap items-center gap-3">
                    {lastUpdated && (
                        <span className="text-sm text-ink-muted hidden sm:inline">
                            Updated <RelativeTime date={lastUpdated} />
                        </span>
                    )}
                    <Button
                        variant="secondary"
                        onClick={handleRefresh}
                        loading={isRefreshing}
                        title="Refresh clusters"
                        /* `pl-2 pr-2`, not `px-2` — see the note in `Table.tsx`. */
                        className="pl-2 pr-2"
                    >
                        {!isRefreshing && <RefreshCw aria-hidden="true" className="size-3.5" />}
                        <span className="sr-only">Refresh</span>
                    </Button>
                    {canManageClusters && (
                        <Button variant="primary" onClick={() => setIsNewDialogOpen(true)}>
                            <Plus className="size-4" />
                            Connect a cluster
                        </Button>
                    )}
                </div>
            </div>

            {isOverClusterLimit && (
                <div
                    role="alert"
                    className="mb-6 flex flex-col gap-3 rounded-md bg-attention-subtle border border-attention-muted px-4 py-3 text-sm text-attention sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                    <span>
                        <strong>
                            Your organization has {clusters.length} clusters, but the {currentPlanName} plan includes{' '}
                            {planLimits.clusters === 1 ? '1 cluster' : `${planLimits.clusters} clusters`}.
                        </strong>{' '}
                        Existing clusters keep working, but you can&apos;t add new ones until you upgrade or remove
                        some.
                    </span>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => router.push('/org-settings?tab=billing')}
                        className="shrink-0"
                    >
                        Upgrade plan
                    </Button>
                </div>
            )}

            {clusters.length === 0 && !edition.multiCluster ? (
                /* A community install whose server has no bootstrap credential:
                   there is no "Connect" to offer, because the edition refuses
                   a cluster made from a request. The fix is configuration. */
                <div className="mt-8 text-center py-12">
                    <Server className="mx-auto size-12 text-ink-faint" />
                    <h3 className="mt-2 text-sm font-semibold text-ink">No cluster configured</h3>
                    <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto">
                        The community edition manages the cluster it runs in. Set{' '}
                        <code className="font-mono text-xs">BOOTSTRAP_CLUSTER_ID</code> and{' '}
                        <code className="font-mono text-xs">BOOTSTRAP_CLUSTER_API_KEY</code> on the server (the Helm
                        chart sets both) and restart it; the cluster appears here on its own.
                    </p>
                </div>
            ) : clusters.length === 0 ? (
                <div className="mt-8 text-center py-12">
                    <Server className="mx-auto size-12 text-ink-faint" />
                    <h3 className="mt-2 text-sm font-semibold text-ink">No Kubernetes clusters yet</h3>
                    <p className="mt-1 text-sm text-ink-muted max-w-md mx-auto">
                        Connect a cluster and StackRadar will automatically discover your running containers, generate
                        SBOMs, and surface vulnerabilities — no manual configuration needed. Install is one Helm
                        command.
                    </p>
                    {canManageClusters ? (
                        <>
                            <Button variant="primary" onClick={() => setIsNewDialogOpen(true)} className="mt-4">
                                <Plus className="size-4" />
                                Connect a cluster
                            </Button>
                            <p className="mt-3 text-xs text-ink-muted">
                                Expect your first findings within minutes of installing the scanner.
                            </p>
                        </>
                    ) : (
                        <p className="mt-3 text-xs text-ink-muted">
                            Ask an organization admin or owner to connect a cluster.
                        </p>
                    )}
                    <ScannerFeatureList />
                    {/* The no-install path, same as the Dashboard's empty
                        state — this page is where "Connect" on the
                        Getting-started banner lands. */}
                    <TryCliCard className="mx-auto mt-8 max-w-xl" />
                </div>
            ) : (
                <ClusterTable
                    clusters={clusters}
                    workloadCountsByCluster={workloadCountsByCluster}
                    onSelect={(c: Cluster) => router.push(`/clusters/${c.id}`)}
                />
            )}

            {canManageClusters && (
                <NewClusterDialog
                    isOpen={isNewDialogOpen}
                    onClose={() => setIsNewDialogOpen(false)}
                    onCreate={createCluster}
                    onInstalled={(cluster: Cluster) =>
                        router.push(`/clusters/${cluster.id}/containers?justInstalled=1`)
                    }
                    onUpgrade={() => router.push('/org-settings?tab=billing')}
                />
            )}
        </div>
    );
}
