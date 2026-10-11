'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, TriangleAlert } from 'lucide-react';

import type { Release, VulnerabilityCounts, Container } from '@/types/container';
import { shortDigest } from '@/utils/containerUtils';
import { formatDate } from '@/utils/formatters';
import {
    Badge,
    EntityIcon,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
    VulnerabilityCounts as VulnerabilityCountsBadges,
    ChartUpgradePanel,
} from '@/components/ui';
import type { ChartUpgrade } from '@/components/ui';
import { useResource } from '@/hooks';

export type ReleaseImage = {
    imageId: string;
    digest: string;
    registry: string | null;
    repository: string | null;
    imageTag: string | null;
};

export type ReleaseDetail = {
    release: Release;
    workloads: Container[];
    images: ReleaseImage[];
    findings: VulnerabilityCounts;
    /** Namespaces its workloads actually landed in — may exceed the release's own. */
    namespaces: string[];
};

/**
 * A Helm release: what it deploys, and what is wrong with it.
 *
 * Release is a **lens** over the same workload rows the namespace and image
 * views show, not a fourth section of the app — which is why this page is
 * reachable from the workloads list's chart grouping rather than from the
 * sidebar.
 *
 * Its workloads come from `workloads.releaseId`, so a chart that deploys into
 * namespaces other than its own still groups here. Grouping by the *workload's*
 * namespace instead is the trap that silently splits one release into several.
 */
export function ReleaseDetailView({ detail }: { detail: ReleaseDetail }) {
    const router = useRouter();
    const { release, workloads, images, findings, namespaces } = detail;

    /* Loaded after the page rather than with it, and allowed to fail quietly
       — its error is never read. Pricing a chart bump diffs every image the
       two releases deploy, and the release's own contents are what the page
       is for — a slow candidate diff must not hold them back. */
    const { data: upgrade } = useResource<ChartUpgrade>(`/api/releases/${release.id}/upgrade`);

    const spansNamespaces = namespaces.length > 1 || (namespaces.length === 1 && namespaces[0] !== release.namespace);

    return (
        <div>
            <div className="mb-6 border-b border-edge pb-4">
                <button
                    onClick={() => router.back()}
                    className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm text-ink-secondary hover:text-ink"
                >
                    <ArrowLeft className="size-4" />
                    Back
                </button>

                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                        <h1 className="flex items-center gap-2 text-xl font-bold leading-tight text-ink sm:text-2xl">
                            <EntityIcon kind="chart" className="size-6 shrink-0 text-ink-muted" />
                            <span className="min-w-0 wrap-break-word">{release.name}</span>
                        </h1>

                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            <Chip label="Namespace" value={release.namespace} />
                            {release.chartName && (
                                <Chip
                                    label="Chart"
                                    value={
                                        release.chartVersion
                                            ? `${release.chartName} ${release.chartVersion}`
                                            : release.chartName
                                    }
                                />
                            )}
                            {release.appVersion && <Chip label="App version" value={release.appVersion} />}
                            {/* An observed repo is a fact; an attributed one is
                                an inference, and the chip says which it is. */}
                            {!release.repoUrl && release.attributedRepoUrl ? (
                                <Chip label="Repository (via Artifact Hub)" value={release.attributedRepoUrl} />
                            ) : (
                                <Chip
                                    label="Repository"
                                    value={release.repoUrl ?? 'Unknown'}
                                    muted={!release.repoUrl}
                                />
                            )}
                            {/* The matched package itself, so the inference
                                above (or the agreement below it) is one click
                                from being checked. */}
                            {release.artifactHub && (
                                <a
                                    href={release.artifactHub.url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    title={`${release.artifactHub.repoName}/${release.chartName ?? ''} on Artifact Hub`}
                                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-surface-muted px-2 py-1 text-ink hover:border-edge-strong hover:text-accent"
                                >
                                    <span className="shrink-0 text-ink-muted">Artifact Hub</span>
                                    <span className="min-w-0 truncate font-medium">{release.artifactHub.repoName}</span>
                                    <ExternalLink aria-hidden="true" className="size-3" />
                                </a>
                            )}
                        </div>

                        {/* Only an attribution can claim this — a null stays
                            silent rather than asserting "not deprecated". */}
                        {release.chartDeprecated === true && (
                            <p className="mt-3 flex items-start gap-2 rounded-md border border-attention-muted bg-attention-subtle px-3 py-2 text-sm text-attention">
                                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                                <span>
                                    Artifact Hub lists this chart as <span className="font-semibold">deprecated</span> —
                                    newer versions may never come, and a maintained replacement is worth finding.
                                </span>
                            </p>
                        )}

                        {/* Several repositories publish a chart called `nginx`.
                            Until a repo URL is known, "all releases of chart X"
                            is a name match, and saying so is the difference
                            between a caveat and a wrong answer. */}
                        {release.chartNameAmbiguous && (
                            <p className="mt-3 flex items-start gap-2 rounded-md border border-attention-muted bg-attention-subtle px-3 py-2 text-sm text-attention">
                                <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                                <span>
                                    Another release uses the chart name{' '}
                                    <span className="font-semibold">{release.chartName}</span>. Without a repository URL
                                    we cannot tell whether it is the same chart, so they are not treated as one.
                                </span>
                            </p>
                        )}

                        {spansNamespaces && (
                            <p className="mt-3 text-sm text-ink-muted">
                                This release deploys into {namespaces.length}{' '}
                                {namespaces.length === 1 ? 'namespace' : 'namespaces'} ({namespaces.join(', ')}), which
                                is why its workloads are grouped by release rather than by where they landed.
                            </p>
                        )}
                    </div>

                    <div className="shrink-0 sm:text-right">
                        <p className="mb-1 text-xs text-ink-muted">Findings across all its images</p>
                        <VulnerabilityCountsBadges
                            critical={findings.critical}
                            high={findings.high}
                            medium={findings.medium}
                            low={findings.low}
                            aggregated
                        />
                    </div>
                </div>
            </div>

            {/* Above the inventory, because it is the action and the rest is
                the evidence. Release scope is the *escalation*, not the
                default — image scope has a smaller blast radius — so this
                panel says what one `helm upgrade` moves and leaves the choice
                to the reader. */}
            {upgrade && (
                <section className="mb-8">
                    <h2 className="mb-3 text-base font-semibold text-ink">Chart upgrade</h2>
                    <ChartUpgradePanel upgrade={upgrade} />
                </section>
            )}

            <section className="mb-8">
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-ink">
                    <EntityIcon kind="image" className="size-4 text-ink-muted" />
                    Images
                    <Badge variant="neutral">{images.length}</Badge>
                </h2>
                {/* Distinct images, not one per workload. This is the list a
                    `helm upgrade` has to move. */}
                <TableContainer variant="section">
                    <Table aria-label="Images this release deploys">
                        <TableHead>
                            <TableHeader>Repository</TableHeader>
                            <TableHeader>Tag</TableHeader>
                            <TableHeader hideBelow="md">Digest</TableHeader>
                        </TableHead>
                        <TableBody>
                            {images.map((image) => (
                                <TableRow key={image.imageId} hoverable>
                                    <TableCell>
                                        <Link
                                            href={`/images/${image.imageId}`}
                                            className="inline-flex items-center gap-1.5 text-ink hover:text-accent hover:underline"
                                        >
                                            <EntityIcon kind="image" className="shrink-0" />
                                            <span className="break-all">
                                                {image.repository ?? image.registry ?? 'Unknown'}
                                            </span>
                                        </Link>
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-ink-muted break-all">
                                        {image.imageTag ?? <span>digest-pinned</span>}
                                    </TableCell>
                                    <TableCell
                                        hideBelow="md"
                                        className="font-mono text-xs text-ink-muted"
                                        title={image.digest}
                                    >
                                        {shortDigest(image.digest)}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </section>

            <section>
                <h2 className="mb-3 flex items-center gap-2 text-base font-semibold text-ink">
                    <EntityIcon kind="container" className="size-4 text-ink-muted" />
                    Containers
                    <Badge variant="neutral">{workloads.length}</Badge>
                </h2>
                <TableContainer variant="section">
                    <Table aria-label="Containers this release deploys">
                        <TableHead>
                            <TableHeader hideBelow="md">Namespace</TableHeader>
                            <TableHeader>Workload</TableHeader>
                            <TableHeader hideBelow="sm">Container</TableHeader>
                            <TableHeader hideBelow="lg">Scanned</TableHeader>
                            <TableHeader align="end">Vulnerabilities</TableHeader>
                        </TableHead>
                        <TableBody>
                            {workloads.map((w) => (
                                <TableRow key={w.id} hoverable>
                                    <TableCell hideBelow="md" className="text-ink-secondary">
                                        {w.namespaceName}
                                    </TableCell>
                                    <TableCell>
                                        <Link
                                            href={`/clusters/${w.clusterId}/containers/${w.id}`}
                                            className="text-ink hover:text-accent hover:underline"
                                        >
                                            {w.workloadName}
                                        </Link>
                                        {w.workloadKind && (
                                            <Badge variant="neutral" className="ml-2">
                                                {w.workloadKind}
                                            </Badge>
                                        )}
                                        {/* The Namespace column is collapsed below `md`. */}
                                        <span className="block text-xs text-ink-muted md:hidden">
                                            {w.namespaceName}
                                        </span>
                                    </TableCell>
                                    <TableCell hideBelow="sm" className="text-ink-secondary">
                                        {w.name}
                                    </TableCell>
                                    <TableCell hideBelow="lg" className="text-ink-secondary">
                                        {w.scannedAt ? formatDate(w.scannedAt) : 'Not scanned'}
                                    </TableCell>
                                    <TableCell align="end">
                                        {w.vulnerabilities ? (
                                            <VulnerabilityCountsBadges
                                                critical={w.vulnerabilities.critical}
                                                high={w.vulnerabilities.high}
                                                medium={w.vulnerabilities.medium}
                                                low={w.vulnerabilities.low}
                                            />
                                        ) : (
                                            <span className="text-ink-muted">—</span>
                                        )}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            </section>
        </div>
    );
}

function Chip({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
    return (
        <span
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-edge bg-surface-muted px-2 py-1"
            title={`${label}: ${value}`}
        >
            <span className="shrink-0 text-ink-muted">{label}</span>
            <span className={`min-w-0 truncate font-medium ${muted ? 'text-ink-muted italic' : 'text-ink'}`}>
                {value}
            </span>
        </span>
    );
}
