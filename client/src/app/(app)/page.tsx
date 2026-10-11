import { DashboardView } from '@/views';

/**
 * `/` — the dashboard: live posture across every cluster in the organization.
 * The page is a route shell; everything it shows is `DashboardView`.
 */
export default function DashboardPage() {
    return <DashboardView />;
}
