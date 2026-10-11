'use client';

import { baseImageLine, controlHeadline } from '@/lib/image-control';
import { useState, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Download, Eye, Package, ShieldAlert } from 'lucide-react';
import { SiKubernetes } from 'react-icons/si';
import {
    BaseUpgradePanel,
    Badge,
    EntityIcon,
    ErrorBlock,
    LoadingBlock,
    TabBar,
    TabPanel,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    VulnerabilityCounts,
    ImageUpgradePanel,
    RiskCell,
} from '@/components/ui';
import type { ImageUpgrade } from '@/components/ui';
import { VulnerabilitiesTab } from '@/components/container-detail';
import { VulnerabilityList } from '@/components/clusters';
import { useResource } from '@/hooks';
import type { Image, ImageDeployment } from '@/types/container';
import { formatDate, formatRelativeTime, isDigestLikeTag } from '@/utils/formatters';
import { sbomDocumentUrl } from '@/lib/sbom';

type ImageDetail = Image & { deployments: ImageDeployment[] };

type Tab = 'vulnerabilities' | 'components' | 'deployments';

/**
 * An image: what is wrong with it, and everywhere it runs.
 *
 * The remediation view. One page per thing a user can actually change — "bump
 * `image:` from A to B" is a single decision however many workloads share the
 * digest, and the deployments table is where that decision has to land.
 *
 * The header says what the page is before it says which image, because every
 * route into it (a Start-here row, a Fix, a feed entry, a release's image
 * list) lands the reader here without a sidebar section to orient them.
 */
export function ImageDetailView({ imageId: id }: { imageId: string }) {
    const router = useRouter();

    const [activeTab, setActiveTab] = useState<Tab>('vulnerabilities');

    const {
        data: image,
        error,
        isLoading: loading,
    } = useResource<ImageDetail>(`/api/images/${id}`, { fallbackError: 'Failed to load image' });

    /* Fetched separately from the image, and allowed to fail quietly — its
       error is never read. The recommendation diffs findings across several
       digests, so it is the slowest thing on the page and the least
       essential — the image's own findings are the page, and holding all of
       it behind a candidate diff would be the wrong trade. */
    const { data: upgrade } = useResource<ImageUpgrade>(`/api/images/${id}/upgrade`);

    if (loading) {
        return <LoadingBlock />;
    }

    if (error || !image) {
        return (
            <ErrorBlock
                title="Failed to load image"
                message={error}
                onRetry={() => router.push('/clusters')}
                retryLabel="Back to Clusters"
            />
        );
    }

    const base = baseImageLine(image);
    const vulns = image.vulnerabilities;
    const vulnTotal = vulns ? vulns.critical + vulns.high + vulns.medium + vulns.low : undefined;

    const tabs = [
        { id: 'vulnerabilities' as Tab, name: 'Vulnerabilities', icon: ShieldAlert, count: vulnTotal },
        { id: 'components' as Tab, name: 'Vulnerable components', icon: Package },
        { id: 'deployments' as Tab, name: 'Deployments', icon: SiKubernetes, count: image.deployments.length },
    ];

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
                        {/* One image is one cluster's view of the digest
                            (ADR 0006), so the cluster is what the page sits
                            under, not deployment trivia. */}
                        <nav aria-label="Breadcrumb" className="mb-1 text-sm text-ink-muted">
                            <Link href="/clusters" className="hover:text-ink">
                                Clusters
                            </Link>
                            {image.clusterName && (
                                <>
                                    <span className="mx-1.5 text-ink-faint">/</span>
                                    <Link href={`/clusters/${image.clusterId}`} className="hover:text-ink">
                                        {image.clusterName}
                                    </Link>
                                </>
                            )}
                            <span className="mx-1.5 text-ink-faint">/</span>
                            <span className="text-ink-secondary">Image</span>
                        </nav>
                        <h1 className="flex items-center gap-2 text-xl font-bold leading-tight text-ink sm:text-2xl">
                            <EntityIcon kind="image" className="size-6 shrink-0 text-ink-muted" />
                            <span className="min-w-0 wrap-break-word">
                                {image.repository ?? image.registry ?? 'Image'}
                            </span>
                        </h1>
                        <p className="mt-1 break-all font-mono text-xs text-ink-muted">{image.digest}</p>
                        {/* Where the base image ends, when something could say:
                            what the "Base image" findings below belong to. */}
                        {base && (
                            <p className="mt-1 text-sm text-ink-secondary">
                                Base image:{' '}
                                {base.ref && <code className="break-all font-mono text-xs text-ink">{base.ref}</code>}
                                {base.ref && base.layers && ' · '}
                                {base.layers}
                            </p>
                        )}
                        {/* Whose image this is decides what can be recommended:
                            for yours, dependency bumps and a base rebuild; for a
                            third-party one, the single upstream upgrade below. */}
                        {controlHeadline(image) && (
                            <p className="mt-1 text-sm text-ink-secondary">
                                {controlHeadline(image)}
                                {image.control === 'third-party' && upgrade?.best && (
                                    <span className="text-ink-muted"> · newer tag {upgrade.best.tag}</span>
                                )}
                            </p>
                        )}
                        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
                            A container image running in
                            {image.clusterName ? ` ${image.clusterName}` : ' your cluster'}. Its findings belong to the
                            image, so one upgrade clears them for every workload that runs it.
                        </p>

                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            {image.registry && <Badge variant="neutral">{image.registry}</Badge>}
                            {/* A digest may carry several tags, or none — which
                                is exactly why the tag lives on the deployment
                                and not on the image. */}
                            {image.tags.length > 0 ? (
                                image.tags.map((tag) => (
                                    <Badge key={tag} variant="neutral">
                                        {tag}
                                    </Badge>
                                ))
                            ) : (
                                <span className="text-ink-muted italic">No tag — digest-pinned everywhere</span>
                            )}
                            <span className="text-ink-muted">
                                {image.containerCount} {image.containerCount === 1 ? 'container' : 'containers'}
                            </span>
                            {/* "Scanned" = the SBOM was generated; "Checked" = its
                                packages were last matched against the advisory
                                mirror. Two dates because they answer different
                                questions: how old is the inventory, and how
                                fresh are the findings. The long forms live in
                                the tooltips (client/CONTEXT.md glossary). */}
                            <span
                                className="text-ink-muted"
                                title={image.scannedAt ? `SBOM generated ${formatDate(image.scannedAt)}` : undefined}
                            >
                                {image.scannedAt ? `Scanned ${formatDate(image.scannedAt)}` : 'Not scanned yet'}
                            </span>
                            {image.scannedAt && (
                                <span
                                    className="text-ink-muted"
                                    title={
                                        image.lastMatchedAt
                                            ? `Advisories checked: packages last matched against the OSV vulnerability database ${formatDate(image.lastMatchedAt)}`
                                            : 'The SBOM has not been matched against the OSV vulnerability database yet'
                                    }
                                >
                                    {image.lastMatchedAt
                                        ? `Checked ${formatRelativeTime(image.lastMatchedAt)}`
                                        : 'Check pending'}
                                </span>
                            )}
                            {image.sbomId && <span className="text-ink-muted">{image.componentCount} packages</span>}
                            {/* The saved SBOM, one click from the date it was
                                generated: the auditor's "what was running"
                                answer is the document, not the summary. */}
                            {image.sbomId && (
                                <span className="inline-flex items-center gap-3">
                                    <a
                                        href={sbomDocumentUrl(image.sbomId, { download: true })}
                                        className="inline-flex items-center gap-1 text-accent hover:underline"
                                        title="Download the CycloneDX SBOM"
                                    >
                                        <Download aria-hidden="true" className="size-3.5" />
                                        SBOM
                                    </a>
                                    <a
                                        href={sbomDocumentUrl(image.sbomId)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-accent hover:underline"
                                        title="Open the CycloneDX SBOM in a new tab"
                                    >
                                        <Eye aria-hidden="true" className="size-3.5" />
                                        View
                                    </a>
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="shrink-0 sm:text-right">
                        <p className="mb-1 text-xs text-ink-muted">Radar Score</p>
                        <RiskCell risk={image.risk} />
                        <p className="mb-1 mt-3 text-xs text-ink-muted">Findings</p>
                        {vulns ? (
                            <VulnerabilityCounts
                                critical={vulns.critical}
                                high={vulns.high}
                                medium={vulns.medium}
                                low={vulns.low}
                                aggregated
                            />
                        ) : (
                            <span className="text-sm text-ink-muted">Not scanned</span>
                        )}
                    </div>
                </div>
            </div>

            {/* The answer, above the evidence. Everything below is what is wrong
                with the image; this is what to do about it. */}
            {upgrade && (
                <div className="mb-6">
                    <h2 className="mb-2 text-sm font-semibold text-ink">Upgrade</h2>
                    <ImageUpgradePanel upgrade={upgrade} />
                </div>
            )}

            {/* The base bucket's one action — for an image you can rebuild.
                A third-party image's base is upstream's to change, and its
                one action is the upgrade above. Renders nothing while the
                base is unknown. */}
            {image.control !== 'third-party' && (
                <div className="mb-6">
                    <BaseUpgradePanel imageId={image.id} />
                </div>
            )}

            <TabBar
                tabs={tabs}
                activeTab={activeTab}
                onChange={(tab) => setActiveTab(tab as Tab)}
                label="Image sections"
            />

            {/* The same findings, twice: by advisory — the list every other
                Vulnerabilities surface shows — and by the component that
                carries them, which is the unit of a dependency bump. A
                third-party image opens both on every finding: there is one
                action for the whole image, so which packages the findings
                are in barely matters. The lens is still there. */}
            <TabPanel tabId="vulnerabilities" active={activeTab === 'vulnerabilities'}>
                {/* Suspense: the filters read the URL. */}
                <Suspense>
                    <VulnerabilityList
                        apiBase={`/api/images/${image.id}/vulnerabilities`}
                        contextKey={image.id}
                        imageId={image.id}
                        {...(image.control === 'third-party' ? { defaultLens: 'all' as const } : {})}
                        scopeLabel="this image"
                        cardsOwner="header"
                        headingLevel="h2"
                        ariaLabel="Vulnerabilities in this image"
                        emptyText={{
                            filtered: 'No vulnerabilities in this image match the current filter.',
                            none: image.scannedAt
                                ? 'No confirmed vulnerabilities in this image.'
                                : 'This image has not been scanned yet.',
                        }}
                    />
                </Suspense>
            </TabPanel>

            <TabPanel tabId="components" active={activeTab === 'components'}>
                {/* Suspense: the findings lens reads the URL. */}
                <Suspense>
                    <VulnerabilitiesTab
                        imageId={image.id}
                        {...(image.control === 'third-party' ? { defaultLens: 'all' as const } : {})}
                    />
                </Suspense>
            </TabPanel>

            <TabPanel tabId="deployments" active={activeTab === 'deployments'}>
                <p className="mb-3 text-sm text-ink-muted">
                    Everywhere this image runs. One change to the image lands in every row below.
                </p>
                <TableContainer variant="section">
                    <Table aria-label="Deployments of this image">
                        <TableHead>
                            <TableHeader hideBelow="md">Namespace</TableHeader>
                            <TableHeader>Workload</TableHeader>
                            <TableHeader hideBelow="sm">Container</TableHeader>
                            <TableHeader hideBelow="lg">Tag</TableHeader>
                            <TableHeader align="end">Pods</TableHeader>
                        </TableHead>
                        {image.deployments.length === 0 ? (
                            /* An uploaded-but-not-yet-inventoried image: the
                               org's own upload, with nowhere it runs yet. */
                            <TableEmpty colSpan={5}>Not running anywhere the scanner has reported yet.</TableEmpty>
                        ) : (
                            <TableBody>
                                {image.deployments.map((d) => (
                                    <TableRow key={d.containerId} hoverable>
                                        <TableCell hideBelow="md" className="text-ink-secondary">
                                            {d.namespaceName}
                                        </TableCell>
                                        <TableCell>
                                            <Link
                                                href={`/clusters/${d.clusterId}/containers/${d.containerId}`}
                                                className="inline-flex items-center gap-1.5 text-ink hover:text-accent hover:underline"
                                            >
                                                <EntityIcon kind="container" />
                                                {d.workloadName}
                                            </Link>
                                            {d.workloadKind && (
                                                <Badge variant="neutral" className="ml-2">
                                                    {d.workloadKind}
                                                </Badge>
                                            )}
                                            {/* The Namespace column is collapsed below `md`. */}
                                            <span className="block text-xs text-ink-muted md:hidden">
                                                {d.namespaceName}
                                            </span>
                                        </TableCell>
                                        <TableCell hideBelow="sm" className="text-ink-secondary">
                                            {d.containerName}
                                        </TableCell>
                                        <TableCell hideBelow="lg" className="font-mono text-xs text-ink-muted">
                                            {/* A digest-like tag — a bare image ID recorded by
                                                old scanners — reads as digest-pinned, not as a
                                                64-character tag. */}
                                            {d.imageTag && !isDigestLikeTag(d.imageTag) ? (
                                                d.imageTag
                                            ) : (
                                                <span>digest-pinned</span>
                                            )}
                                        </TableCell>
                                        <TableCell align="end" className="tabular-nums text-ink-secondary">
                                            {d.runningPods ?? '—'}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        )}
                    </Table>
                </TableContainer>
            </TabPanel>
        </div>
    );
}
