import type { ContainerExposure } from '@/types/container';
import type { TierLens } from '@/lib/tier-lens';

export type Tab = 'dependencies' | 'vulnerabilities' | 'sbom' | 'deployments' | 'osv-sync';

/**
 * Every tab is keyed by a `workload_containers` id.
 *
 * The data behind them all comes from the *image* that container references —
 * one SBOM, one component set, one set of findings, shared by every place the
 * image runs. The container id is the addressable thing; the image is the
 * subject.
 */
export interface DependenciesTabProps {
    containerId: string;
}

/**
 * The one tab that is also a page section elsewhere: the image page shows the
 * same table, keyed on the image directly, because the findings are the
 * image's and a digest may run under no container at all (an upload that
 * has not been inventoried yet).
 */
export type VulnerabilitiesTabProps = (
    { containerId: string; imageId?: never } | { imageId: string; containerId?: never }
) & {
    /**
     * The lens the table opens on when neither the URL nor the reader's last
     * choice says otherwise. "application" by default; a page about an image
     * the org does not build opens on "all" (component tier plan, item 13).
     */
    defaultLens?: TierLens;
    /**
     * The container's exposure (`GET /api/containers/:id/exposure`), fetched
     * by the page so its header and this table share one read. Absent on the
     * image page — a digest has no one slot to have been running on — and
     * while loading; either way the Exposed column is left out.
     */
    exposure?: ContainerExposure | null;
};

export interface SbomItem {
    id: string;
    createdAt: string;
    specVersion: string;
    documentVersion: number | null;
    imageId: string;
    /** From the container, not the SBOM — a tag is a deployment fact. */
    imageTag: string | null;
    imageRef: string;
    toolName: string | null;
    toolVersion: string | null;
    sourceName: string | null;
    componentCount: number;
}

export interface ImageSbomTabProps {
    containerId: string;
}

export interface ScanRunItem {
    id: string;
    sbomId: string | null;
    jobId: string | null;
    trigger: string;
    status: 'success' | 'partial' | 'failed';
    componentsScanned: number;
    vulnsFound: number;
    counts: {
        critical: number;
        high: number;
        medium: number;
        low: number;
    };
    osvMirrorSyncedAt: string | null;
    errorMessage: string | null;
    startedAt: string | null;
    completedAt: string;
    durationMs: number | null;
    createdAt: string;
}

export interface OsvSyncTabProps {
    containerId: string;
}

export interface DeploymentsTabProps {
    containerId: string;
}
