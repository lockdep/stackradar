'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { ContainersLoading } from '@/components/containers';
import { ClusterContainersView } from '@/views';

/**
 * `/clusters/[id]/containers` — the cluster's containers by namespace. The
 * Suspense boundary is for `useSearchParams`, which Next requires to sit
 * under one; the view reads nothing from the URL itself.
 */
export default function ClusterContainersPage() {
    return (
        <Suspense fallback={<ContainersLoading />}>
            <ClusterContainersRoute />
        </Suspense>
    );
}

function ClusterContainersRoute() {
    const justInstalled = useSearchParams().get('justInstalled') === '1';
    return <ClusterContainersView justInstalled={justInstalled} />;
}
