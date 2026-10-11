import { ClusterChartsView } from '@/views';

/** `/clusters/[id]/charts` — the Helm releases installed in one cluster, one row per release. */
export default function ClusterChartsPage() {
    return <ClusterChartsView />;
}
