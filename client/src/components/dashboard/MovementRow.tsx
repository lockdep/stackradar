'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';
import {
    Badge,
    EntityIcon,
    ExposureDuration,
    KevBadge,
    RelativeTime,
    SeverityDelta,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
import { formatShortDigest, isDigestLikeTag } from '@/utils/formatters';
import type { FixListItem } from '@/types/fixes';
import type { MovementContainer, MovementImage } from '@/types/feed';
import { fixFor, type FixIndex } from './fix-hints';
import { MovementFindings, UnfoldedSection } from './MovementFindings';
import type { MovementFilters } from './movement-query';

/** A row this fresh carries the "New" mark — the movement that most likely post-dates the reader's last look. */
const NEW_WITHIN_MS = 24 * 60 * 60 * 1000;
/** Containers an unfolded row lists before asking. */
const CONTAINERS_PREVIEW = 8;

export function MovementRow({
    image,
    now,
    expanded,
    filters,
    fixIndex,
    onToggle,
    onOpenVulnerability,
}: {
    image: MovementImage;
    now: string;
    expanded: boolean;
    filters: MovementFilters;
    fixIndex: FixIndex;
    onToggle: () => void;
    onOpenVulnerability: (vulnId: string) => void;
}) {
    /* Measured against the server's `until`, not the wall clock: render stays
       pure, and the mark is about the data's age, not how long the tab has been open. */
    const isNew = new Date(now).getTime() - new Date(image.lastAt).getTime() < NEW_WITHIN_MS;
    const href = `/images/${image.imageId}`;
    /* `:tag` when the image runs under a real one, `@sha256:…` otherwise — the
       reference form a reader would type, not a tag-shaped digest. */
    const tag = image.tag && !isDigestLikeTag(image.tag) ? image.tag : null;
    const digest = tag ? null : formatShortDigest(image.digest);
    const label = image.repository ?? 'unknown repository';
    /* The registry host rides in front from `lg` up, where the row has the
       width for the full path. Some repositories already carry their host. */
    const registry =
        image.registry && image.repository && !image.repository.startsWith(`${image.registry}/`)
            ? image.registry
            : null;
    const runsIn = image.runsIn ?? [];
    const namespaces = [...new Set(runsIn.map((w) => w.namespace))];
    /* The server keeps an image for an arrival in a chosen band but counts
       every band; with the toggle off the lower two read as zero here, as the
       findings under the unfolded row already leave them out. */
    const added = filters.includeLower ? image.added : { ...image.added, medium: 0, low: 0 };
    const releaseIds = runsIn.map((c) => c.releaseId);
    /* "See fix" is a promise the reader can act on, so only on an image the
       org builds: a third-party image's move is upstream's to ship, and its
       row just opens the image. An older server sends no `control`; the
       move's own says whose it is. */
    const move = fixFor(fixIndex, image.imageId, releaseIds);
    const thirdParty = image.control != null ? image.control === 'third-party' : move?.control === 'third-party';
    const hasMove = move !== undefined && !thirdParty;

    return (
        <Fragment>
            {/* The row unfolds; the "Open" link on the right is the way to the
                image page. One click, one thing. */}
            <TableRow onClick={onToggle} selected={expanded} aria-expanded={expanded}>
                <TableCell className="w-8 pr-0">
                    {/* The row is the tab stop (`TableRow`); the chevron stays for the pointer. */}
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-hidden="true"
                        aria-label={`${expanded ? 'Hide' : 'Show'} the findings that arrived on ${label}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggle();
                        }}
                        className="cursor-pointer rounded-sm p-0.5 hover:bg-btn-secondary-hover"
                    >
                        <ChevronRight
                            aria-hidden="true"
                            className={`size-4 text-ink-secondary transition-transform duration-100 ${
                                expanded ? 'rotate-90' : ''
                            }`}
                        />
                    </button>
                </TableCell>
                <TableCell>
                    <span className="flex flex-wrap items-center gap-1.5">
                        <EntityIcon kind="image" />
                        <span className="font-mono text-xs font-medium text-ink break-all">
                            {registry && <span className="hidden text-ink-muted lg:inline">{registry}/</span>}
                            {label}
                            {tag && <span className="text-ink-muted">:{tag}</span>}
                            {digest && <span className="text-ink-muted">@{digest}</span>}
                        </span>
                        {isNew && <Badge variant="accent">New</Badge>}
                    </span>
                    {/* The same digest in two clusters is two rows (images are
                        cluster-scoped), told apart only by the Cluster column —
                        so the name rides under the image while that column is
                        collapsed. */}
                    {image.clusterName && (
                        <span className="mt-0.5 block text-xs text-ink-muted md:hidden">{image.clusterName}</span>
                    )}
                </TableCell>
                <TableCell hideBelow="md" className="text-xs text-ink-secondary whitespace-nowrap">
                    {image.clusterName ? (
                        <span className="inline-flex items-center gap-1.5">
                            <EntityIcon kind="cluster" className="size-3.5 text-ink-muted" />
                            {image.clusterName}
                        </span>
                    ) : (
                        <span className="text-ink-faint">—</span>
                    )}
                </TableCell>
                <TableCell hideBelow="xl" className="text-xs text-ink-secondary whitespace-nowrap">
                    <FirstAndMore values={namespaces} />
                </TableCell>
                <TableCell className="text-xs">
                    <span className="inline-flex flex-wrap items-center gap-1.5">
                        <SeverityDelta sign="+" counts={added} noun="added" compact />
                        <KevBadge count={image.kev} />
                    </span>
                </TableCell>
                <TableCell hideBelow="lg" className="text-xs text-ink-muted whitespace-nowrap">
                    <RelativeTime date={new Date(image.lastAt)} />
                </TableCell>
                <TableCell align="end" className="whitespace-nowrap">
                    <Link
                        href={href}
                        onClick={(e) => e.stopPropagation()}
                        title={
                            hasMove
                                ? 'Open the image — its upgrade recommendation and every finding on it are there'
                                : 'Open the image — every finding on it is listed there'
                        }
                        className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                        {/* Says "fix" only once the upgrade list knows a move for one of the org's own images; it lands after the rows do. */}
                        {hasMove ? 'See fix' : 'Open image'}
                        <ArrowRight aria-hidden="true" className="size-3" />
                    </Link>
                </TableCell>
            </TableRow>
            {expanded && (
                <TableRow className="bg-surface-muted">
                    {/* Mounted only while unfolded, so the fetch happens on demand
                        and again on re-open — the list is fresh either way. */}
                    <TableCell colSpan={7} className="pl-4 sm:pl-10">
                        {/* The cell's own padding is the table density's; the
                            cards need more air than a row does. */}
                        <div className="pt-2 pb-5">
                            {/* What arrived first — the question the row's counts
                                raise — then where it runs. */}
                            <MovementFindings
                                image={image}
                                href={href}
                                filters={filters}
                                fixIndex={fixIndex}
                                releaseIds={releaseIds}
                                onOpenVulnerability={onOpenVulnerability}
                            />
                            <MovementContainers
                                clusterId={image.clusterId}
                                containers={runsIn}
                                chartFixes={fixIndex.byRelease}
                            />
                        </div>
                    </TableCell>
                </TableRow>
            )}
        </Fragment>
    );
}

/**
 * The first of a list, and how many more there are. An image usually runs in
 * one place; when it runs in several the row stays one line and the rest are
 * a hover away — the image page lists them all.
 */
function FirstAndMore({ values }: { values: string[] }) {
    if (values.length === 0) return <span className="text-ink-faint">—</span>;
    const more = values.length - 1;
    return (
        <span title={values.join('\n')}>
            {values[0]}
            {more > 0 && <span className="text-ink-muted"> +{more.toLocaleString()} more</span>}
        </span>
    );
}

/**
 * Every container running the image now, under the unfolded row — the main
 * row says only which cluster and namespace. Already in the block's response, so unfolding fetches nothing for it.
 */
function MovementContainers({
    clusterId,
    containers,
    chartFixes,
}: {
    clusterId: string | null;
    containers: MovementContainer[];
    chartFixes: ReadonlyMap<string, FixListItem>;
}) {
    const [all, setAll] = useState(false);
    if (containers.length === 0) return null;
    const shown = all ? containers : containers.slice(0, CONTAINERS_PREVIEW);
    const hidden = containers.length - shown.length;

    return (
        <UnfoldedSection title="Running in" count={containers.length} noun={['container', 'containers']}>
            <TableContainer square>
                <Table aria-label="Containers running this image" density="condensed" textSize="xs">
                    <TableHead>
                        <TableHeader>Container</TableHeader>
                        <TableHeader>Namespace</TableHeader>
                        <TableHeader hideBelow="sm">Kind</TableHeader>
                        {/* What packaged it, when a Helm release claims the
                            workload — the chart is what a fix is cited against. */}
                        <TableHeader hideBelow="md">Helm chart</TableHeader>
                        {/* Per container, so "running this image for": the row is an
                            image with several arrivals, and how long each
                            finding has been there is on its own row above. */}
                        <TableHeader align="end" className="whitespace-nowrap">
                            <span title="How long the container has run this exact image. How long each finding has been in it is on the finding's row.">
                                Running this image for
                            </span>
                        </TableHeader>
                    </TableHead>
                    <TableBody>
                        {shown.map((c) => (
                            <TableRow key={c.containerId}>
                                <TableCell className="break-all">
                                    <span className="inline-flex items-center gap-1.5">
                                        <EntityIcon kind="container" className="size-3.5 shrink-0 text-ink-muted" />
                                        <ContainerName clusterId={clusterId} container={c} />
                                    </span>
                                </TableCell>
                                <TableCell className="text-ink-secondary break-all">{c.namespace}</TableCell>
                                <TableCell hideBelow="sm" className="text-ink-muted whitespace-nowrap">
                                    {c.workloadKind ?? <span className="text-ink-faint">—</span>}
                                </TableCell>
                                <TableCell hideBelow="md" className="break-all">
                                    <HelmChart
                                        container={c}
                                        fix={c.releaseId ? chartFixes.get(c.releaseId) : undefined}
                                    />
                                </TableCell>
                                <TableCell align="end" className="text-ink-muted">
                                    <ExposureDuration
                                        since={c.onImageSince}
                                        isLowerBound={c.onImageSinceIsLowerBound}
                                        reason="first-observation"
                                    />
                                </TableCell>
                            </TableRow>
                        ))}
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
        </UnfoldedSection>
    );
}

/**
 * The chart that packaged a container's workload, linked to its release page.
 * A release whose chart metadata could not be read is named by the release;
 * a workload no release claims gets a dash.
 */
function HelmChart({ container, fix }: { container: MovementContainer; fix: FixListItem | undefined }) {
    if (!container.releaseId) return <span className="text-ink-faint">—</span>;
    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Link
                href={`/releases/${container.releaseId}`}
                onClick={(e) => e.stopPropagation()}
                title={`Helm release ${container.releaseName ?? ''}`.trim()}
                className="inline-flex items-center gap-1.5 text-ink-secondary underline-offset-2 hover:text-accent hover:underline"
            >
                <EntityIcon kind="chart" className="size-3.5 shrink-0 text-ink-muted" />
                <span>
                    {container.chartName ?? container.releaseName}
                    {container.chartName && container.chartVersion && (
                        <span className="text-ink-muted"> {container.chartVersion}</span>
                    )}
                </span>
            </Link>
            {/* A newer version the upgrade list knows of, stated as exactly
                that: "available". No arrow from the running version — an
                arrow reads as "move here and this is fixed", and nothing on
                this row knows whether the newer chart clears the findings
                above. The release page has the recommendation. */}
            {fix && (
                <Link
                    href={`/releases/${container.releaseId}`}
                    onClick={(e) => e.stopPropagation()}
                    title="A newer chart version exists — the release page has the recommendation"
                    className="inline-flex items-center gap-1 whitespace-nowrap text-accent hover:underline"
                >
                    {fix.to} available
                    {fix.bump === 'major' && <Badge variant="attention">major</Badge>}
                </Link>
            )}
        </span>
    );
}

/**
 * A container named as the Containers page names it — the workload, plus the
 * container's own name only when it differs — and linked to its page.
 */
function ContainerName({ clusterId, container }: { clusterId: string | null; container: MovementContainer }) {
    const name = (
        <>
            {container.workloadName}
            {container.name !== container.workloadName && <span className="text-ink-muted"> / {container.name}</span>}
        </>
    );
    if (!clusterId) return <span>{name}</span>;
    return (
        <Link
            href={`/clusters/${clusterId}/containers/${container.containerId}`}
            onClick={(e) => e.stopPropagation()}
            className="text-ink-secondary underline-offset-2 hover:text-accent hover:underline"
        >
            {name}
        </Link>
    );
}
