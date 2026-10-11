'use client';

import { useState } from 'react';
import { ContainersEmpty } from '@/components/containers';
import { ClusterCoverageCard } from './ClusterCoverageCard';
import { ConnectClusterDialog } from './ConnectClusterDialog';
import { rotateClusterApiKey } from './rotateClusterApiKey';
import { useCluster } from './ClusterContext';

/**
 * The "no containers yet" state for a cluster, plus the connect dialog it opens.
 *
 * Shared by the Overview and Containers tabs: a cluster whose scanner has never
 * checked in has nothing to chart either, so Overview showing empty axes while
 * only Containers explained why was a dead end for a brand-new cluster.
 *
 * Coverage belongs here and not only on a populated Overview, because "no
 * workloads at all" is the *worst* version of a coverage gap, not the absence
 * of one: a scanner that cannot authenticate to the registry reports its
 * inventory fine and then fails every scan, which without this panel looks
 * exactly like a cluster still waiting for its first upload. It renders
 * nothing when no inventory has been reported, which is the genuine
 * still-installing case.
 */
export function ClusterEmptyState({ justInstalled = false }: { justInstalled?: boolean }) {
    const { cluster } = useCluster();
    const [dialogOpen, setDialogOpen] = useState(false);
    /* Generating a key inside the dialog changes which panel belongs here, and
       the panel's own key lookup is a separate fetch — so re-run it on close. */
    const [refreshKey, setRefreshKey] = useState(0);

    return (
        <>
            <ContainersEmpty
                cluster={cluster}
                onConnect={() => setDialogOpen(true)}
                refreshKey={refreshKey}
                justInstalled={justInstalled}
            />
            {/* Margin on the card itself, not a wrapper — a wrapper would hold
                8 units of empty space open on the genuine still-installing
                case, where the card renders nothing. */}
            <ClusterCoverageCard clusterId={cluster.id} className="mt-8" />
            <ConnectClusterDialog
                isOpen={dialogOpen}
                onClose={() => {
                    setDialogOpen(false);
                    setRefreshKey((k) => k + 1);
                }}
                cluster={cluster}
                onRotateApiKey={rotateClusterApiKey}
            />
        </>
    );
}
