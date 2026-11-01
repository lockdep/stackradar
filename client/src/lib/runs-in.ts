import type { ImageDeployment } from '@/types/container';

/** Namespaces named in full before the line folds the rest into "+N more". */
const NAMED_NAMESPACES = 3;

/** What the image page's "Runs in" line is built from: the distinct namespaces and workloads of its rows. */
export type RunsIn = { namespaces: string[]; workloadCount: number };

/**
 * The deployment rows folded to what the header line says: distinct namespace
 * names, sorted, and how many distinct workloads (not containers — an init
 * and a main container of one Deployment are one place it runs). Null when
 * nothing has reported running the image, so the line is left out rather
 * than saying "0 workloads".
 */
export function summarizeRunsIn(deployments: readonly ImageDeployment[]): RunsIn | null {
    if (deployments.length === 0) return null;
    const namespaces = [...new Set(deployments.map((d) => d.namespaceName))].sort((a, b) => a.localeCompare(b));
    const workloadCount = new Set(deployments.map((d) => d.workloadId)).size;
    return { namespaces, workloadCount };
}

/**
 * `["argocd", "5 workloads", "platform-eu1"]` — the parts of the line, for the
 * view to join with " · ". Namespaces first because that is the question the
 * page used to answer three clicks in; more than three fold into "+N more",
 * since the tab under the line lists every one. The cluster is last and only
 * when known.
 */
export function runsInParts({ namespaces, workloadCount }: RunsIn, clusterName: string | null): string[] {
    const named = namespaces.slice(0, NAMED_NAMESPACES).join(', ');
    const more = namespaces.length - NAMED_NAMESPACES;
    const where = more > 0 ? `${named} +${more} more` : named;
    const workloads = `${workloadCount.toLocaleString()} ${workloadCount === 1 ? 'workload' : 'workloads'}`;
    return clusterName ? [where, workloads, clusterName] : [where, workloads];
}
