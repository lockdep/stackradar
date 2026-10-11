'use client';

import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Badge, EntityIcon, LoadingBlock, RiskCell, TableCell, TableRow } from '@/components/ui';
import { ContainerSeverityCell, ScanDot } from '@/components/containers';
import { ImageControlTag, type ControlChoice } from '@/components/image-control';
import { useResource } from '@/hooks';
import type { Image, ImageDeployment } from '@/types/container';
import { shortDigest } from '@/utils/containerUtils';
import { formatAge, formatDate, formatShortDate, isDigestLikeTag } from '@/utils/formatters';
import { builtAt } from './image-sort';

/**
 * One image. The name is the repository; what follows it is what the
 * deployments asked for — the tag when there is exactly one story to tell,
 * `+n` when several tags resolve to this digest, and the digest itself when
 * every deployment pins it. Null findings render as a dash, never as zeroes.
 *
 * The row opens on the containers running the image — the answer to the
 * Containers count — fetched when it is first opened. The chevron sits in
 * the name cell rather than a column of its own, so the fixed layout gives
 * the name the width.
 */
export function ImageRow({
    image,
    expanded,
    onToggle,
    onControlChange,
}: {
    image: Image;
    expanded: boolean;
    onToggle: () => void;
    /** Present when the reader may correct whose image this is. */
    onControlChange: ((next: ControlChoice) => void) | undefined;
}) {
    const name = image.repository ?? image.registry ?? shortDigest(image.digest);
    const fullName = [image.registry, image.repository].filter(Boolean).join('/') || image.digest;
    const tags = image.tags.filter((t) => !isDigestLikeTag(t));
    const where = [image.registry, image.clusterName].filter(Boolean).join(' · ');
    const built = builtAt(image);

    return (
        <>
            <TableRow hoverable onClick={onToggle} aria-expanded={expanded}>
                <TableCell className="align-middle">
                    <div className="flex min-w-0 items-center gap-1.5">
                        {/* The row is the tab stop (`TableRow`); the chevron stays for the pointer. */}
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-hidden="true"
                            aria-label={`${expanded ? 'Hide' : 'Show'} containers running ${name}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggle();
                            }}
                            className="shrink-0 cursor-pointer rounded-sm p-0.5 text-ink-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-emphasis"
                        >
                            {expanded ? (
                                <ChevronDown aria-hidden="true" className="size-3.5" />
                            ) : (
                                <ChevronRight aria-hidden="true" className="size-3.5" />
                            )}
                        </button>
                        <Link
                            href={`/images/${image.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="group/name flex min-w-0 items-center gap-2 text-ink hover:text-accent"
                            title={`${fullName}${tags.length > 0 ? `:${tags.join(', :')}` : ''}\n${image.digest}`}
                        >
                            <EntityIcon kind="image" className="size-4 text-ink-muted" />
                            <ScanDot subject={image} />
                            <span className="min-w-0">
                                <span className="block truncate underline-offset-2 group-hover/name:underline">
                                    {name}
                                    {tags.length > 0 ? (
                                        <span className="text-ink-muted">
                                            :{tags[0]}
                                            {tags.length > 1 && ` +${tags.length - 1}`}
                                        </span>
                                    ) : (
                                        image.repository && (
                                            <span className="text-ink-muted">@{shortDigest(image.digest)}</span>
                                        )
                                    )}
                                </span>
                                {/* The registry, and the cluster while its column is collapsed. */}
                                {where && (
                                    <span className="block truncate text-xs text-ink-muted">
                                        {image.registry}
                                        {image.clusterName && (
                                            <span className="xl:hidden">
                                                {image.registry && ' · '}
                                                {image.clusterName}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </span>
                        </Link>
                    </div>
                </TableCell>

                <TableCell hideBelow="xl" className="align-middle">
                    <ImageControlTag
                        control={image.control}
                        detectedBy={image.controlDetectedBy}
                        detail={image.controlDetail}
                        repository={fullName}
                        onChange={onControlChange}
                    />
                </TableCell>

                <TableCell hideBelow="xl" className="truncate align-middle">
                    <Link
                        href={`/clusters/${image.clusterId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex max-w-full items-center gap-1.5 text-ink underline-offset-2 hover:text-accent hover:underline"
                        title={image.clusterName ?? undefined}
                    >
                        <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                        <span className="truncate">{image.clusterName ?? '—'}</span>
                    </Link>
                </TableCell>

                <TableCell hideBelow="md" align="end" className="align-middle tabular-nums text-ink-secondary">
                    {image.containerCount.toLocaleString()}
                </TableCell>

                {/* The last OSV-mirror match — the findings' freshness — as on
                    the containers list; the SBOM's date is in the hover. */}
                <TableCell hideBelow="xl" className="truncate align-middle text-ink-muted">
                    {image.lastMatchedAt ? (
                        <span
                            title={`Advisories checked ${formatDate(image.lastMatchedAt)} · SBOM generated ${formatDate(image.scannedAt)}`}
                        >
                            {formatShortDate(image.lastMatchedAt)}
                        </span>
                    ) : image.scannedAt ? (
                        <span title={`SBOM generated ${formatDate(image.scannedAt)} · advisory check pending`}>
                            Pending
                        </span>
                    ) : (
                        <span>Not scanned</span>
                    )}
                </TableCell>

                <TableCell hideBelow="xl" align="end" className="align-middle tabular-nums text-ink-muted">
                    <span title={`First seen in this cluster ${formatDate(image.firstSeenAt)}`}>
                        {formatAge(image.firstSeenAt)}
                    </span>
                </TableCell>

                <TableCell hideBelow="xl" align="end" className="align-middle tabular-nums text-ink-muted">
                    {built ? (
                        <span title={`Built ${formatDate(built)}`}>{formatAge(built)}</span>
                    ) : (
                        <span title="No usable build date: the scanner did not report one, or the image carries a placeholder">
                            —
                        </span>
                    )}
                </TableCell>

                <TableCell align="end" className="whitespace-nowrap align-middle">
                    <RiskCell risk={image.risk} />
                </TableCell>

                <TableCell align="end" className="whitespace-nowrap align-middle">
                    <ContainerSeverityCell vulnerabilities={image.vulnerabilities} />
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow>
                    {/* Wider than the table at any breakpoint: a span past the
                        last column is clamped, so one number covers them all. */}
                    <TableCell colSpan={COLUMN_COUNT} className="bg-surface-muted">
                        <ImageContainers imageId={image.id} />
                    </TableCell>
                </TableRow>
            )}
        </>
    );
}

/** The table's column count: the unfolded row spans every column, whatever the breakpoint collapsed. */
const COLUMN_COUNT = 9;

/**
 * The containers running one image — `GET /api/images/:id/deployments`, the
 * image page's "Running in" table as a compact list. Every line is the same
 * image, so it carries no score: only where it runs and how it was asked for.
 */
function ImageContainers({ imageId }: { imageId: string }) {
    const { data, error, isLoading } = useResource<ImageDeployment[]>(`/api/images/${imageId}/deployments`, {
        fallbackError: 'Failed to fetch containers',
    });

    if (isLoading) return <LoadingBlock className="py-4" />;
    if (error) return <p className="py-2 pl-7 text-xs text-danger">{error}</p>;
    if (!data || data.length === 0) {
        return <p className="py-2 pl-7 text-xs text-ink-muted">No running container references this image any more.</p>;
    }

    const sorted = [...data].sort(
        (a, b) =>
            a.namespaceName.localeCompare(b.namespaceName) ||
            a.workloadName.localeCompare(b.workloadName) ||
            a.containerName.localeCompare(b.containerName),
    );

    return (
        <ul className="py-1 pl-7" aria-label="Containers running this image">
            {sorted.map((d) => {
                const tag = d.imageTag && !isDigestLikeTag(d.imageTag) ? d.imageTag : null;
                return (
                    <li key={d.containerId} className="flex min-w-0 items-center gap-2 py-1">
                        <EntityIcon kind="container" className="size-3.5 text-ink-muted" />
                        <Link
                            href={`/clusters/${d.clusterId}/containers/${d.containerId}`}
                            className="min-w-0 truncate text-ink underline-offset-2 hover:text-accent hover:underline"
                            title={`${d.namespaceName} / ${d.workloadName} / ${d.containerName}`}
                        >
                            <span className="text-ink-muted">{d.namespaceName} / </span>
                            {d.workloadName}
                            {d.containerName !== d.workloadName && (
                                <span className="text-ink-muted"> / {d.containerName}</span>
                            )}
                        </Link>
                        {/* Null is "the scanner could not tell", never a kind of its own. */}
                        {d.workloadKind && (
                            <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">
                                {d.workloadKind}
                            </Badge>
                        )}
                        {d.init && (
                            <Badge variant="neutral" className="hidden shrink-0 sm:inline-flex">
                                init
                            </Badge>
                        )}
                        <span className="ml-auto shrink-0 whitespace-nowrap text-ink-muted">
                            {tag ? `:${tag}` : 'pinned by digest'}
                            {d.runningPods !== null && (
                                <>
                                    <span className="mx-1.5 text-ink-faint">·</span>
                                    {d.runningPods} {d.runningPods === 1 ? 'pod' : 'pods'}
                                </>
                            )}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}
