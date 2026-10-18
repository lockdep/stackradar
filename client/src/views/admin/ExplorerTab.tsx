'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ChevronRight, Building2, Layers } from 'lucide-react';
import { useTabData } from './useTabData';
import { useRuntimeConfig } from '@/components/providers';
import { TabShell, SourceTables } from './Shared';
import { imageLabel, sbomLabel } from './explorerShared';
import { ExplorerImageList } from './ExplorerImageList';
import { ExplorerSbomList } from './ExplorerSbomList';
import { ExplorerComponentsTable } from './ExplorerComponentsTable';
import { ExplorerComponentDetail } from './ExplorerComponentDetail';
import type { RecentOrg, OrganizationsData, ExplorerImage, ExplorerSbom } from './types';

// ── Top-level tab: org picker + breadcrumb router ────────────────────────────

/**
 * Drill from an image into its SBOM, components and matched vulnerabilities.
 *
 * The first level is the org picker only where there is more than one org
 * to pick (`edition.multiOrg`). A single-org install has exactly one, so the
 * tab starts on its image list and the breadcrumb starts at "Images" — the
 * same `/api/admin/organizations` call supplies the org id either way.
 */
export function ExplorerTab({
    refreshKey,
    onLoadingChange,
}: {
    refreshKey: number;
    onLoadingChange: (v: boolean) => void;
}) {
    const { data, isLoading, error, refetch } = useTabData<OrganizationsData>(
        '/api/admin/organizations',
        refreshKey,
        onLoadingChange,
    );
    const { multiOrg } = useRuntimeConfig().edition;
    const [pickedOrg, setPickedOrg] = useState<RecentOrg | null>(null);
    const [image, setImage] = useState<ExplorerImage | null>(null);
    const [sbom, setSbom] = useState<ExplorerSbom | null>(null);
    const [component, setComponent] = useState<{ id: string; name: string } | null>(null);
    // `?component=` is the image page's way in: straight to one component's
    // match provenance, with no org, image or SBOM picked above it. Clearing
    // it is the breadcrumb's root; the URL is left as it was.
    const linkedParam = useSearchParams().get('component');
    const [linked, setLinked] = useState<string | null>(linkedParam);

    if (linked) {
        return (
            <div>
                <nav className="text-sm text-ink-muted mb-6 flex items-center gap-1 flex-wrap">
                    <button type="button" onClick={() => setLinked(null)} className="hover:text-ink cursor-pointer">
                        {multiOrg ? 'Explorer' : 'Images'}
                    </button>
                    <ChevronRight className="size-3.5 text-ink-faint" />
                    <span className="text-ink font-medium font-mono text-xs">{linked}</span>
                </nav>
                <ExplorerComponentDetail componentId={linked} />
            </div>
        );
    }

    const org = multiOrg ? pickedOrg : (data?.recentOrgs[0] ?? null);
    const setOrg = (o: RecentOrg | null) => {
        if (multiOrg) setPickedOrg(o);
    };

    const crumbs = (
        <nav className="text-sm text-ink-muted mb-6 flex items-center gap-1 flex-wrap">
            <button
                type="button"
                onClick={() => {
                    setOrg(null);
                    setImage(null);
                    setSbom(null);
                    setComponent(null);
                }}
                className={multiOrg || image ? 'hover:text-ink cursor-pointer' : 'text-ink font-medium'}
            >
                {multiOrg ? 'Explorer' : 'Images'}
            </button>
            {multiOrg && org && (
                <>
                    <ChevronRight className="size-3.5 text-ink-faint" />
                    <button
                        type="button"
                        onClick={() => {
                            setImage(null);
                            setSbom(null);
                            setComponent(null);
                        }}
                        className={image ? 'hover:text-ink cursor-pointer' : 'text-ink font-medium'}
                    >
                        {org.name}
                    </button>
                </>
            )}
            {image && (
                <>
                    <ChevronRight className="size-3.5 text-ink-faint" />
                    <button
                        type="button"
                        onClick={() => {
                            setSbom(null);
                            setComponent(null);
                        }}
                        className={sbom ? 'hover:text-ink cursor-pointer' : 'text-ink font-medium'}
                    >
                        {imageLabel(image)}
                    </button>
                </>
            )}
            {sbom && (
                <>
                    <ChevronRight className="size-3.5 text-ink-faint" />
                    <button
                        type="button"
                        onClick={() => setComponent(null)}
                        className={
                            component
                                ? 'hover:text-ink cursor-pointer font-mono text-xs'
                                : 'text-ink font-medium font-mono text-xs'
                        }
                    >
                        {sbomLabel(sbom)}
                    </button>
                </>
            )}
            {component && (
                <>
                    <ChevronRight className="size-3.5 text-ink-faint" />
                    <span className="text-ink font-medium font-mono text-xs">{component.name}</span>
                </>
            )}
        </nav>
    );

    if (org && image && sbom && component) {
        return (
            <div>
                {crumbs}
                <ExplorerComponentDetail componentId={component.id} />
            </div>
        );
    }

    if (org && image && sbom) {
        return (
            <div>
                {crumbs}
                <ExplorerComponentsTable
                    sbom={sbom}
                    onSelectComponent={(c) => setComponent({ id: c.id, name: c.name })}
                />
            </div>
        );
    }

    if (org && image) {
        return (
            <div>
                {crumbs}
                <ExplorerSbomList image={image} onSelectSbom={setSbom} />
            </div>
        );
    }

    if (org) {
        return (
            <div>
                {crumbs}
                <ExplorerImageList
                    org={org}
                    onSelectImage={(i) => {
                        setImage(i);
                        setSbom(null);
                        setComponent(null);
                    }}
                />
            </div>
        );
    }

    return (
        <div>
            {crumbs}
            <TabShell isLoading={isLoading} error={error} onRetry={refetch}>
                {data && !multiOrg && (
                    // The single org has not been seeded yet (`default-org.service.ts`
                    // runs at server start), so there is nothing to explore.
                    <p className="text-sm text-ink-muted">No organization yet.</p>
                )}
                {data && multiOrg && (
                    <div className="bg-surface-raised rounded-md border border-edge p-5">
                        <div className="flex flex-wrap items-start justify-between gap-4 mb-1">
                            <h2 className="text-sm font-semibold text-ink-secondary">Select an organization</h2>
                            <SourceTables tables={['organizations']} />
                        </div>
                        <p className="text-xs text-ink-muted mb-4">
                            Drill from an image into its SBOM, components, and matched vulnerabilities.
                        </p>
                        {data.recentOrgs.length === 0 ? (
                            <p className="text-sm text-ink-muted">No organizations yet.</p>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                                {data.recentOrgs.map((o) => (
                                    <button
                                        key={o.id}
                                        type="button"
                                        onClick={() => setOrg(o)}
                                        className="text-left rounded-md border border-edge bg-surface-raised p-4 hover:border-edge-strong hover:shadow-resting transition-all cursor-pointer"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0">
                                                <p className="font-medium text-ink truncate">{o.name}</p>
                                                <p className="text-xs text-ink-muted font-mono mt-0.5 truncate">
                                                    {o.slug}
                                                </p>
                                            </div>
                                            <Building2 className="size-4 text-ink-faint shrink-0 mt-0.5" />
                                        </div>
                                        <p className="text-xs text-ink-muted mt-2 flex items-center gap-1">
                                            <Layers className="size-3 text-ink-faint" /> {o.sbomCount} SBOMs
                                        </p>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </TabShell>
        </div>
    );
}
