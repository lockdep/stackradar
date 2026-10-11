'use client';

import { Layers, Package } from 'lucide-react';
import { TableContainer, Table, TableHead, TableBody, TableHeader, TableRow, TableCell } from '@/components/ui';
import { SourceTables, KeyHint, SevCounts, ErrorBox, LoadingBox } from './Shared';
import { formatNumber, formatTimeAgo } from './utils';
import { sbomLabel, useExplorerFetch } from './explorerShared';
import type { ExplorerImage, ExplorerSbom, ExplorerSbomsData } from './types';

// ── Level 3: the image's SBOM ────────────────────────────────────────────────

/**
 * At most one row: `sboms_image_id_unique` makes an image's SBOM singular.
 * Kept as a level rather than folded into the image row because the components
 * below hang off the SBOM id, and an image with no SBOM is a state worth seeing.
 */
export function ExplorerSbomList({
    image,
    onSelectSbom,
}: {
    image: ExplorerImage;
    onSelectSbom: (s: ExplorerSbom) => void;
}) {
    const { data, isLoading, error } = useExplorerFetch<ExplorerSbomsData>(
        `/api/admin/explorer/sboms?imageId=${image.imageId}`,
    );

    if (isLoading) return <LoadingBox />;
    if (error) return <ErrorBox message={error} />;
    if (!data) return null;

    if (data.sboms.length === 0) {
        return (
            <div className="rounded-md bg-surface-raised border border-edge p-8 text-center">
                <Layers className="size-8 text-ink-faint/70 mx-auto mb-2" />
                <p className="text-sm text-ink-muted">No SBOM for this image.</p>
            </div>
        );
    }

    return (
        <div className="bg-surface-raised rounded-md border border-edge p-5">
            <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                    <h2 className="text-sm font-semibold text-ink-secondary">SBOM</h2>
                    <p className="text-xs text-ink-muted mt-0.5">
                        One SBOM per image digest · pick it to inspect its components
                    </p>
                    <p className="mt-1 break-all">
                        <KeyHint column="sboms.image_id" value={image.imageId} />
                    </p>
                </div>
                <SourceTables tables={['sboms']} />
            </div>
            <TableContainer variant="plain">
                <Table aria-label="SBOM">
                    <TableHead>
                        <TableHeader>Digest</TableHeader>
                        <TableHeader hideBelow="md">Format</TableHeader>
                        <TableHeader hideBelow="lg">Tool</TableHeader>
                        <TableHeader align="end" hideBelow="sm">
                            Components
                        </TableHeader>
                        <TableHeader>Vulnerabilities</TableHeader>
                        <TableHeader align="end" hideBelow="lg">
                            Scanned
                        </TableHeader>
                    </TableHead>
                    <TableBody>
                        {data.sboms.map((s) => (
                            <TableRow key={s.id} className="group" onClick={() => onSelectSbom(s)}>
                                <TableCell>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            onSelectSbom(s);
                                        }}
                                        className="text-xs sm:text-sm font-medium text-ink group-hover:text-accent font-mono text-left cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                                    >
                                        {sbomLabel(s)}
                                    </button>
                                </TableCell>
                                <TableCell
                                    hideBelow="md"
                                    className="text-xs text-ink-muted uppercase whitespace-nowrap"
                                >
                                    {s.format} {s.specVersion}
                                </TableCell>
                                <TableCell hideBelow="lg" className="text-xs text-ink-muted">
                                    {s.toolName ?? '—'}
                                    {s.toolVersion ? ` ${s.toolVersion}` : ''}
                                </TableCell>
                                <TableCell align="end" hideBelow="sm" className="text-ink-secondary">
                                    <span className="inline-flex items-center gap-1 justify-end">
                                        <Package className="size-3 text-ink-faint" /> {formatNumber(s.componentCount)}
                                    </span>
                                </TableCell>
                                <TableCell>
                                    <SevCounts counts={s.vulnCounts} />
                                </TableCell>
                                <TableCell
                                    align="end"
                                    hideBelow="lg"
                                    className="text-xs text-ink-muted whitespace-nowrap"
                                >
                                    {formatTimeAgo(s.createdAt)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    );
}
