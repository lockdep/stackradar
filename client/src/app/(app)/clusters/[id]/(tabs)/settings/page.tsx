'use client';

import { ClusterIdentityForm, DangerZone, ScannerKeyPanel, clusterSettingsAccess } from '@/components/clusters';
import { useOrganization, useRuntimeConfig } from '@/components/providers';

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
 * URL. The live demo is the one viewer that gets the page without being an
 * admin: read-only, so an evaluator can see the scanner configuration
 * surface (`clusterSettingsAccess`). The server still refuses every write on
 * the demo org, so nothing here depends on the controls being disabled —
 * they are disabled so the page does not offer what would only 403.
 */
export default function ClusterSettingsPage() {
    const { organization } = useOrganization();
    const { demoMode } = useRuntimeConfig();
    const access = clusterSettingsAccess(organization, demoMode);

    if (access === 'none') {
        return (
            <p className="py-8 text-sm text-ink-muted">
                Only organization admins and owners can manage cluster settings.
            </p>
        );
    }

    const readOnly = access === 'read-only';

    return (
        <div className="max-w-2xl space-y-6">
            {readOnly && (
                <p className="text-sm text-ink-muted">
                    Read-only in the demo: this is the settings page an admin sees, with every change disabled.
                </p>
            )}
            <ClusterIdentityForm readOnly={readOnly} />
            <ScannerKeyPanel readOnly={readOnly} />
            <DangerZone />
        </div>
    );
}
