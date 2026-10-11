'use client';

import Link from 'next/link';
import { Boxes, RefreshCw } from 'lucide-react';
import {
    Badge,
    LoadingBlock,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui';
import { useResource } from '@/hooks';
import type { ImageDeployment } from '@/types/container';
import type { DeploymentsTabProps } from './types';
import { isDigestLikeTag } from '@/utils/formatters';

/**
 * Everywhere else this container's image runs.
 *
 * The question the old model could not ask: the same digest in five namespaces
 * was five unrelated projects with five SBOMs, so "what else does this affect?"
 * had no answer. It matters because remediation acts on the image — bumping
 * `image:` is one decision — while the change has to land in every row here.
 */
export function DeploymentsTab({ containerId }: DeploymentsTabProps) {
    const {
        data,
        isLoading,
        error,
        refetch: fetchDeployments,
    } = useResource<ImageDeployment[]>(`/api/containers/${containerId}/siblings`, {
        responseError: () => 'Failed to load deployments',
        fallbackError: 'Failed to load deployments',
        loadingOnRefetch: true,
    });
    const deployments = data ?? [];

    if (isLoading) {
        return <LoadingBlock />;
    }

    if (error) {
        return (
            <div className="py-12 text-center">
                <p className="text-sm font-medium text-ink">Failed to load deployments</p>
                <p className="mt-1 text-sm text-ink-muted">{error}</p>
                <button
                    onClick={fetchDeployments}
                    className="mt-3 inline-flex cursor-pointer items-center gap-1.5 text-sm text-accent hover:underline"
                >
                    <RefreshCw className="size-4" />
                    Try again
                </button>
            </div>
        );
    }

    if (deployments.length === 0) {
        return (
            <div className="py-12 text-center">
                <Boxes className="mx-auto size-12 text-ink-faint/70" />
                <h3 className="mt-2 text-sm font-semibold text-ink">This image runs in one place</h3>
                <p className="mt-1 text-sm text-ink-muted">
                    Nothing else in your organization references this digest, so a fix here affects only this container.
                </p>
            </div>
        );
    }

    return (
        <div>
            <p className="mb-4 text-sm text-ink-muted">
                This image also runs in {deployments.length} {deployments.length === 1 ? 'other place' : 'other places'}
                . Changing it fixes all of them at once — and has to be applied to each.
            </p>

            <TableContainer variant="section">
                <Table aria-label="Other deployments of this image">
                    <TableHead>
                        <TableHeader hideBelow="md">Namespace</TableHeader>
                        <TableHeader>Workload</TableHeader>
                        <TableHeader hideBelow="sm">Container</TableHeader>
                        <TableHeader hideBelow="lg">Tag</TableHeader>
                        <TableHeader align="end">Pods</TableHeader>
                    </TableHead>
                    <TableBody>
                        {deployments.map((d) => (
                            <TableRow key={d.containerId} hoverable>
                                <TableCell hideBelow="md" className="text-ink-secondary">
                                    {d.namespaceName}
                                </TableCell>
                                <TableCell>
                                    <Link
                                        href={`/clusters/${d.clusterId}/containers/${d.containerId}`}
                                        className="inline-flex items-center gap-2 text-ink hover:text-accent hover:underline"
                                    >
                                        {d.workloadName}
                                    </Link>
                                    {d.workloadKind && (
                                        <Badge variant="neutral" className="ml-2">
                                            {d.workloadKind}
                                        </Badge>
                                    )}
                                    {/* The Namespace column is collapsed below `md`. */}
                                    <span className="block text-xs text-ink-muted md:hidden">{d.namespaceName}</span>
                                </TableCell>
                                <TableCell hideBelow="sm" className="text-ink-secondary">
                                    {d.containerName}
                                </TableCell>
                                <TableCell hideBelow="lg" className="font-mono text-xs text-ink-muted">
                                    {/* Blank rather than "latest": a digest-pinned
                                        deployment asked for no tag at all. A
                                        digest-like tag (a bare image ID recorded
                                        by old scanners) reads the same way. */}
                                    {d.imageTag && !isDigestLikeTag(d.imageTag) ? (
                                        d.imageTag
                                    ) : (
                                        <span className="text-ink-muted">digest-pinned</span>
                                    )}
                                </TableCell>
                                <TableCell align="end" className="tabular-nums text-ink-secondary">
                                    {d.runningPods ?? '—'}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </div>
    );
}
