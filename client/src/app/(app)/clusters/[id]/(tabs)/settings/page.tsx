'use client'

import { ClusterIdentityForm, DangerZone, ScannerKeyPanel } from '@/components/clusters'
import { isAdminOrOwner, useOrganization } from '@/components/providers'

/**
 * Deliberately does not consume `useClusterContainers` — Settings needs none of
 * that data, and staying off it is what keeps rename and key rotation reachable
 * when the workloads request fails.
 *
 * Each section owns its own state; the shared cluster (and its rename
 * write-back) travels through `ClusterContext` from the tabs layout.
 *
 * Every section here mutates the cluster, which is admin/owner-only on the
 * server. The tab is already hidden for members; this guard covers a direct
 * URL.
 */
export default function ClusterSettingsPage() {
    const { organization } = useOrganization()

    if (!isAdminOrOwner(organization)) {
        return (
            <p className="py-8 text-sm text-ink-muted">
                Only organization admins and owners can manage cluster settings.
            </p>
        )
    }

    return (
        <div className="max-w-2xl space-y-6">
            <ClusterIdentityForm />
            <ScannerKeyPanel />
            <DangerZone />
        </div>
    )
}
