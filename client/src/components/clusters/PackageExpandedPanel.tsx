'use client';

import Link from 'next/link';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import {
    buttonClasses,
    EntityIcon,
    Spinner,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
import { useResource } from '@/hooks';
import { shortDigest } from '@/utils/containerUtils';
import type { ClusterPackagesResponse, PackageOccurrences } from '@/types/cluster';

type Package = ClusterPackagesResponse['packages'][number];

/** `name version`, the way the popovers and the tables name one row. */
export function packageLabel(pkg: { name: string; version: string | null }): string {
    return pkg.version ? `${pkg.name} ${pkg.version}` : pkg.name;
}

/**
 * The expanded row of a package list: where one `name@version` is, which is
 * the incident question — "which image has libxml2 2.13.9, and what is
 * running it?" — answered in place with the image, namespace and cluster of
 * every hit and a link into each. The data is the count cells' own
 * `/occurrences` drill-down, fetched when the row opens; the popovers stay
 * for a one-column glance, this is the whole answer.
 */
export function PackageExpandedPanel({
    pkg,
    occurrencesUrl,
    showClusters,
}: {
    pkg: Package;
    /** The row's `/occurrences` request, the list's images filter already on it. */
    occurrencesUrl: string;
    /** The org-wide list, where rows span clusters. */
    showClusters: boolean;
}) {
    const occurrences = useResource<PackageOccurrences>(occurrencesUrl, {
        fallbackError: 'Could not load where this package is',
    });
    const label = packageLabel(pkg);

    return (
        <div className="space-y-4 py-2">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <h3 className="font-mono text-sm font-semibold text-ink break-all">{label}</h3>
                    <p className="mt-1 text-xs text-ink-muted break-all">
                        {pkg.purl ?? 'No purl recorded'}
                        {pkg.license && <span> · {pkg.license}</span>}
                    </p>
                </div>
                {/* The other half of the incident: what is wrong with it. The
                    vulnerability list searches by package name. */}
                <Link
                    href={`/vulnerabilities?search=${encodeURIComponent(pkg.name)}`}
                    className={buttonClasses({ variant: 'secondary', size: 'sm', className: 'shrink-0 gap-1' })}
                >
                    Vulnerabilities in {pkg.name}
                    <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
            </div>

            {occurrences.error ? (
                <p className="flex items-start gap-1.5 text-xs text-attention">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    {occurrences.error}
                </p>
            ) : occurrences.data ? (
                <PackageOccurrencesTables data={occurrences.data} label={label} showClusters={showClusters} />
            ) : (
                <div className="flex items-center gap-2 py-2 text-xs text-ink-muted">
                    <Spinner size="sm" className="text-ink-faint" />
                    Loading where it runs…
                </div>
            )}
        </div>
    );
}

/** `registry/repository`, or the digest when the image carries no name. */
function imageRef(image: PackageOccurrences['images'][number]): string {
    const repository = image.repository ?? shortDigest(image.digest);
    const registry = image.registry && !repository.startsWith(`${image.registry}/`) ? `${image.registry}/` : '';
    return `${registry}${repository}`;
}

/**
 * The two tables of the expanded row: the images carrying the version and
 * the containers running those images, each hit a link to its page. Pure
 * over the fetched payload, so the row's rendering is testable without a
 * fetch.
 */
export function PackageOccurrencesTables({
    data,
    label,
    showClusters,
}: {
    data: PackageOccurrences;
    label: string;
    showClusters: boolean;
}) {
    const { images, workloads } = data;
    return (
        <div className="grid gap-4 xl:grid-cols-2">
            <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                    <EntityIcon kind="image" />
                    {images.length === 1 ? '1 image carries it' : `${images.length.toLocaleString()} images carry it`}
                </h4>
                {images.length === 0 ? (
                    <p className="text-xs text-ink-muted">No scanned image carries this package any more.</p>
                ) : (
                    <TableContainer>
                        <Table aria-label={`Images carrying ${label}`} density="condensed" textSize="xs">
                            <TableHead>
                                <TableHeader className="w-full">Image</TableHeader>
                                {showClusters && <TableHeader hideBelow="sm">Cluster</TableHeader>}
                                <TableHeader hideBelow="md">Digest</TableHeader>
                            </TableHead>
                            <TableBody>
                                {images.map((image) => (
                                    <TableRow key={image.id}>
                                        <TableCell className="break-all">
                                            <Link
                                                href={`/images/${encodeURIComponent(image.id)}`}
                                                className="inline-flex items-center gap-1.5 font-mono text-accent hover:underline"
                                            >
                                                <EntityIcon kind="image" className="size-3.5 shrink-0 text-ink-muted" />
                                                {imageRef(image)}
                                            </Link>
                                        </TableCell>
                                        {showClusters && (
                                            <TableCell hideBelow="sm" className="whitespace-nowrap text-ink-secondary">
                                                {image.clusterName}
                                            </TableCell>
                                        )}
                                        <TableCell hideBelow="md" className="font-mono text-ink-muted">
                                            {shortDigest(image.digest)}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </section>

            <section>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                    <EntityIcon kind="container" />
                    {workloads.length === 1
                        ? '1 workload runs it'
                        : `${workloads.length.toLocaleString()} workloads run it`}
                </h4>
                {workloads.length === 0 ? (
                    <p className="text-xs text-ink-muted">
                        Not running anywhere yet — the images are scanned, but nothing reported running them.
                    </p>
                ) : (
                    <TableContainer>
                        <Table aria-label={`Containers running ${label}`} density="condensed" textSize="xs">
                            <TableHead>
                                <TableHeader className="w-full">Workload</TableHeader>
                                <TableHeader>Namespace</TableHeader>
                                <TableHeader hideBelow="md">Kind</TableHeader>
                                {showClusters && <TableHeader hideBelow="sm">Cluster</TableHeader>}
                            </TableHead>
                            <TableBody>
                                {workloads.map((workload) => (
                                    <TableRow key={workload.containerId}>
                                        <TableCell className="break-words">
                                            <Link
                                                href={`/clusters/${encodeURIComponent(workload.clusterId)}/containers/${encodeURIComponent(workload.containerId)}`}
                                                className="inline-flex items-center gap-1.5 text-accent hover:underline"
                                            >
                                                <EntityIcon
                                                    kind="container"
                                                    className="size-3.5 shrink-0 text-ink-muted"
                                                />
                                                {workload.workloadName}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="whitespace-nowrap text-ink-secondary">
                                            {workload.namespaceName}
                                        </TableCell>
                                        <TableCell hideBelow="md" className="whitespace-nowrap text-ink-secondary">
                                            {workload.workloadKind ?? (
                                                <span
                                                    className="text-ink-muted"
                                                    title="The scanner could not read the kind"
                                                >
                                                    —
                                                </span>
                                            )}
                                        </TableCell>
                                        {showClusters && (
                                            <TableCell hideBelow="sm" className="whitespace-nowrap text-ink-secondary">
                                                {workload.clusterName}
                                            </TableCell>
                                        )}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </section>
        </div>
    );
}
