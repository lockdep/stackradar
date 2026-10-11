'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import {
    EntityIcon,
    LoadingBlock,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
/* The file, not the barrel: the dashboard's barrel imports this folder's. */
import { FixCellHint, type FixIndex } from '@/components/dashboard/fix-hints';
import { useResource } from '@/hooks';
import { formatShortDigest } from '@/utils/formatters';
import type { VulnerabilityOccurrences } from '@/types/cluster';

type AffectedImage = VulnerabilityOccurrences['images'][number];
type AdvisoryPackage = { name: string; version: string | null; fixedVersion: string | null };

/** `next@16.2.12` — how a package version is named. */
const packageLabel = (pkg: { name: string; version: string | null }) =>
    pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;

/** Images an unfolded row lists before asking. */
const IMAGES_PREVIEW = 8;

/** `next 16.3.3` — the fix the advisory states for what this image has installed; null when it states none. */
function packageFixFor(image: AffectedImage, packages: readonly AdvisoryPackage[]): string | null {
    for (const installed of image.packages ?? []) {
        const match = packages.find(
            (p) => p.name === installed.name && p.version === installed.version && p.fixedVersion,
        );
        if (match) return `${match.name} ${match.fixedVersion}`;
    }
    return null;
}

/**
 * The images one advisory affects, by their full reference: what each has
 * installed, how many containers run it, and the move the upgrade list knows
 * for it — the unfolded row of the Dashboard's "Most critical" and of the
 * vulnerability lists. Fetched on mount from the caller's `/occurrences` url,
 * which carries the caller's filters, so the list is what the row's counts
 * counted. The containers themselves are the image page's and the
 * vulnerability page's business.
 */
export function AffectedImagesTable({
    url,
    vulnId,
    packages,
    fixIndex,
    showCluster = true,
}: {
    /** The `/occurrences` request for the row — identity, lens and scope already on it. */
    url: string;
    vulnId: string;
    /** The row's packages: where an image's fix version comes from when the upgrade list has no move. */
    packages: readonly AdvisoryPackage[];
    fixIndex: FixIndex;
    /** Off on a cluster tab, where every image is the one cluster's. */
    showCluster?: boolean;
}) {
    const [all, setAll] = useState(false);
    const { data, error } = useResource<VulnerabilityOccurrences>(url, {
        fallbackError: 'Could not load the affected images',
    });
    const images: AffectedImage[] | undefined = data?.images;

    const section = (body: React.ReactNode, count?: number) => (
        <section>
            <h3 className="mb-1.5 text-xs font-medium text-ink">
                Affected images
                {count !== undefined && (
                    <span className="font-normal text-ink-muted">
                        {' '}
                        · {count.toLocaleString()} {count === 1 ? 'image' : 'images'}
                    </span>
                )}
            </h3>
            {body}
        </section>
    );

    if (!images && !error) return section(<LoadingBlock label="Listing affected images..." className="py-2" />);
    if (!images) return section(<p className="py-1 text-xs text-ink-muted">{error}</p>);
    if (images.length === 0) {
        return section(
            <p className="py-1 text-xs text-ink-muted">No scanned images carry this advisory any more.</p>,
            0,
        );
    }

    const shown = all ? images : images.slice(0, IMAGES_PREVIEW);
    const hidden = images.length - shown.length;

    return section(
        <>
            <TableContainer square>
                <Table aria-label={`Images affected by ${vulnId}`} density="condensed" textSize="xs">
                    <TableHead>
                        <TableHeader className="w-full">Image</TableHeader>
                        <TableHeader hideBelow="md">Installed</TableHeader>
                        {showCluster && <TableHeader hideBelow="lg">Cluster</TableHeader>}
                        <TableHeader align="end">Containers</TableHeader>
                        <TableHeader hideBelow="sm">
                            <span title="The move the upgrade list knows for the image, or why it has none. The image page has the recommendation in full.">
                                Fix
                            </span>
                        </TableHeader>
                        <TableHeader srOnly>Open</TableHeader>
                    </TableHead>
                    <TableBody>
                        {shown.map((image) => {
                            /* Some repositories already carry their host. */
                            const registry =
                                image.registry && image.repository && !image.repository.startsWith(`${image.registry}/`)
                                    ? image.registry
                                    : null;
                            return (
                                <TableRow key={image.id}>
                                    <TableCell className="break-all">
                                        <span className="inline-flex items-center gap-1.5 font-mono text-ink">
                                            <EntityIcon kind="image" className="size-3.5 shrink-0 text-ink-muted" />
                                            <span>
                                                {registry && <span className="text-ink-muted">{registry}/</span>}
                                                {image.repository ?? 'unknown repository'}
                                                <span className="text-ink-muted">
                                                    @{formatShortDigest(image.digest)}
                                                </span>
                                            </span>
                                        </span>
                                        {showCluster && (
                                            <span className="mt-0.5 block text-ink-muted lg:hidden">
                                                {image.clusterName}
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell
                                        hideBelow="md"
                                        className="font-mono text-ink-secondary whitespace-nowrap"
                                    >
                                        {image.packages && image.packages.length > 0 ? (
                                            <span className="flex flex-col gap-0.5">
                                                {/* The server lists a version once per place it was
                                                    found; this column only says which versions. */}
                                                {[
                                                    ...new Map(
                                                        image.packages.map((p) => [packageLabel(p), p]),
                                                    ).values(),
                                                ].map((p) => (
                                                    <span key={packageLabel(p)}>
                                                        {p.name}
                                                        {p.version && (
                                                            <span className="text-ink-muted">@{p.version}</span>
                                                        )}
                                                    </span>
                                                ))}
                                            </span>
                                        ) : (
                                            <span className="text-ink-faint">—</span>
                                        )}
                                    </TableCell>
                                    {showCluster && (
                                        <TableCell hideBelow="lg" className="text-ink-secondary whitespace-nowrap">
                                            <span className="inline-flex items-center gap-1.5">
                                                <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                                                {image.clusterName}
                                            </span>
                                        </TableCell>
                                    )}
                                    <TableCell align="end" className="tabular-nums text-ink-secondary">
                                        {/* 0 is "scanned but not in any inventory yet" — a dash, as on the row above. */}
                                        {image.containerCount ? (
                                            image.containerCount.toLocaleString()
                                        ) : (
                                            <span
                                                className="text-ink-muted"
                                                title="Nothing has reported running this image"
                                            >
                                                —
                                            </span>
                                        )}
                                    </TableCell>
                                    <TableCell hideBelow="sm">
                                        <FixCellHint
                                            index={fixIndex}
                                            imageId={image.id}
                                            packageFix={packageFixFor(image, packages)}
                                        />
                                    </TableCell>
                                    <TableCell align="end" className="whitespace-nowrap">
                                        <Link
                                            href={`/images/${image.id}`}
                                            title="Open the image — its recommendation and every finding on it are there"
                                            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                                        >
                                            Open
                                            <ArrowRight aria-hidden="true" className="size-3" />
                                        </Link>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
            {(hidden > 0 || all) && (
                <button
                    type="button"
                    onClick={() => setAll((v) => !v)}
                    className="mt-2 cursor-pointer text-xs text-accent hover:underline"
                >
                    {all ? 'Show fewer' : `Show ${hidden.toLocaleString()} more`}
                </button>
            )}
        </>,
        images.length,
    );
}
