import { Suspense } from 'react';
import { VulnerabilitiesView } from '@/views';

/**
 * /vulnerabilities — every cluster's Vulnerabilities tab folded into one.
 * The Suspense boundary is for the severity filter, which reads the URL.
 */
export default function VulnerabilitiesPage() {
    return (
        <Suspense>
            <VulnerabilitiesView />
        </Suspense>
    );
}
