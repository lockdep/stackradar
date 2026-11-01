import { Suspense } from 'react';
import { DashboardView } from '@/views';

/**
 * `/` — the dashboard: live posture across every cluster in the organization.
 * The page is a route shell; everything it shows is `DashboardView`. The
 * Suspense boundary is for the cluster / namespace scope, which reads the URL.
 */
export default function DashboardPage() {
    return (
        <Suspense>
            <DashboardView />
        </Suspense>
    );
}
