import { Suspense } from 'react';
import { ContainersView } from '@/views';

/**
 * /containers — every cluster's Containers tab folded into one flat,
 * worst-first list. The Suspense boundary is for the sort and scope
 * parameters, which read the URL.
 */
export default function ContainersPage() {
    return (
        <Suspense>
            <ContainersView />
        </Suspense>
    );
}
