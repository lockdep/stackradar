'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, ShieldAlert, Wrench } from 'lucide-react';
import { Button, ErrorBlock, LoadingBlock } from '@/components/ui';
import {
    VulnerabilityFixDialog,
    VulnerabilityOverviewBody,
    VulnerabilityOverviewHeading,
    useVulnerabilityOverview,
} from '@/components/clusters';

/**
 * One advisory as this organization sees it: what it is, how it ranks, and
 * every image and workload carrying it — the page a vulnerability id links to.
 *
 * The same three facts the Vulnerabilities list's row unfolds to (advisory
 * records, affected images, affected workloads), composed by the server
 * under one id so that a link from anywhere — a dashboard row, a feed entry —
 * lands on a page rather than a row to find. The id in the URL is the one
 * a reader would type; a GHSA whose identity is its CVE resolves to the
 * CVE's row.
 *
 * The body is shared with the Dashboard's vulnerability dialog
 * (`VulnerabilityDialog`), which shows the same overview without leaving
 * the page; this route is the linkable, shareable form of it.
 *
 * Scoped to the org's scanned images: an advisory nothing here carries is
 * "not in your clusters", with an OSV link, not a public advisory page — the
 * product's question is always "does this affect me".
 */
export default function VulnerabilityPage() {
    const { vulnId } = useParams<{ vulnId: string }>();
    const router = useRouter();
    const displayId = decodeURIComponent(vulnId);

    const { data, error, isLoading, refetch } = useVulnerabilityOverview(displayId);
    const [isFixOpen, setIsFixOpen] = useState(false);

    if (isLoading && !data) return <LoadingBlock />;

    if (error === 'not-found') {
        return (
            <div>
                <BackLink onClick={() => router.back()} />
                <ErrorBlock
                    icon={<ShieldAlert aria-hidden="true" className="size-6 text-ink-muted" />}
                    title={`${displayId} is not in your clusters`}
                    message="No scanned image in this organization carries this advisory. It may have been fixed, or never affected anything here."
                    onRetry={() => router.push('/vulnerabilities')}
                    retryLabel="All vulnerabilities"
                />
                <p className="mt-2 text-center text-sm text-ink-muted">
                    <a
                        href={`https://osv.dev/vulnerability/${encodeURIComponent(displayId)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                        Look it up on OSV.dev
                        <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                </p>
            </div>
        );
    }

    if (error || !data) {
        return <ErrorBlock title="Failed to load this vulnerability" message={error} onRetry={refetch} />;
    }

    return (
        <div>
            <div className="mb-6 border-b border-edge pb-4">
                <BackLink onClick={() => router.back()} />

                <nav aria-label="Breadcrumb" className="mb-1 text-sm text-ink-muted">
                    <Link href="/vulnerabilities" className="hover:text-ink">
                        Vulnerabilities
                    </Link>
                    <span className="mx-1.5 text-ink-faint">/</span>
                    <span className="text-ink-secondary">{data.vulnerability.vulnId}</span>
                </nav>

                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                    <div className="min-w-0">
                        <VulnerabilityOverviewHeading
                            vulnerability={data.vulnerability}
                            exposure={data.exposure}
                            remediation={data.remediation}
                            as="h1"
                        />
                    </div>
                    {/* The list row's button, opening the same dialog. */}
                    <Button
                        variant="secondary"
                        size="sm"
                        className="shrink-0"
                        disabled={!data.vulnerability.fixAvailable}
                        title={
                            data.vulnerability.fixAvailable
                                ? undefined
                                : 'No advisory states a fix version for the matched packages'
                        }
                        onClick={() => setIsFixOpen(true)}
                    >
                        <Wrench aria-hidden="true" className="size-3.5" />
                        Fix this
                    </Button>
                </div>
            </div>

            <VulnerabilityOverviewBody data={data} />

            <VulnerabilityFixDialog
                target={
                    isFixOpen
                        ? {
                              vuln: data.vulnerability,
                              /* Unfiltered and org-wide: every image the page itself lists. */
                              occurrencesUrl: `/api/vulnerabilities/occurrences?${new URLSearchParams({ identity: data.vulnerability.identity })}`,
                          }
                        : null
                }
                onClose={() => setIsFixOpen(false)}
                showClusters
            />
        </div>
    );
}

function BackLink({ onClick }: { onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="mb-3 inline-flex cursor-pointer items-center gap-2 text-sm text-ink-secondary hover:text-ink"
        >
            <ArrowLeft className="size-4" />
            Back
        </button>
    );
}
