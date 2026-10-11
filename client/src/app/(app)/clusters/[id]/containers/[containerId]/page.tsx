'use client';

import { useParams, useRouter } from 'next/navigation';
import { ContainerDetailView } from '@/views';
import { LoadingBlock } from '@/components/ui';
import { useResource } from '@/hooks';
import type { Container } from '@/types/container';
import type { Cluster } from '@/types/cluster';

export default function ContainerDetailPage() {
    const { id, containerId } = useParams<{ id: string; containerId: string }>();
    const router = useRouter();

    /* One request per resource, no parent lookup. The namespace, container
       and release names all ride on the container row now — under the old
       tree they lived on a `parentId` row that had to be fetched
       separately. */
    const containerResource = useResource<Container>(`/api/containers/${containerId}`, {
        fallbackError: 'Failed to load container',
    });
    const clusterResource = useResource<Cluster>(`/api/clusters/${id}`, {
        select: (body) => (body as { cluster: Cluster }).cluster,
        fallbackError: 'Failed to load container',
    });
    const container = containerResource.data;
    const cluster = clusterResource.data;
    const error = containerResource.error ?? clusterResource.error;
    const loading = containerResource.isLoading || clusterResource.isLoading;

    if (loading) {
        return <LoadingBlock />;
    }

    if (error || !container || !cluster) {
        return (
            <div className="flex items-center justify-center py-24">
                <div className="text-center">
                    <p className="text-sm font-medium text-ink">Failed to load container</p>
                    <p className="mt-1 text-sm text-ink-muted">{error}</p>
                    <button
                        onClick={() => router.push(`/clusters/${id}`)}
                        className="mt-4 cursor-pointer text-sm text-success hover:underline"
                    >
                        Back to Cluster
                    </button>
                </div>
            </div>
        );
    }

    return <ContainerDetailView container={container} cluster={cluster} />;
}
