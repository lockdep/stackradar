import { describe, expect, it } from 'vitest';
import type { ImageDeployment } from '@/types/container';
import { runsInParts, summarizeRunsIn } from './runs-in';

const row = (namespaceName: string, workloadId: string, containerName = 'main'): ImageDeployment => ({
    containerId: `${workloadId}-${containerName}`,
    containerName,
    init: containerName === 'init',
    imageTag: '2.9.0',
    imageRef: 'quay.io/argoproj/argocd:2.9.0',
    runningPods: 1,
    workloadId,
    workloadName: workloadId,
    workloadKind: 'Deployment',
    namespaceId: `ns-${namespaceName}`,
    namespaceName,
    clusterId: 'cl-1',
    releaseId: null,
    applicationId: null,
});

/**
 * The image page's "Runs in" line: namespaces, workload count, cluster — the
 * answer that used to be a tab and a table away, as one line under the title.
 */
describe('summarizeRunsIn', () => {
    it('is null when nothing has reported running the image', () => {
        expect(summarizeRunsIn([])).toBeNull();
    });

    it('counts workloads, not containers, and lists each namespace once, sorted', () => {
        const summary = summarizeRunsIn([
            row('monitoring', 'repo-server'),
            row('argocd', 'repo-server', 'init'),
            row('argocd', 'repo-server'),
            row('argocd', 'app-controller'),
        ]);
        expect(summary).toEqual({ namespaces: ['argocd', 'monitoring'], workloadCount: 2 });
    });
});

describe('runsInParts', () => {
    it('reads "argocd · 1 workload · platform-eu1" for one place', () => {
        expect(runsInParts({ namespaces: ['argocd'], workloadCount: 1 }, 'platform-eu1')).toEqual([
            'argocd',
            '1 workload',
            'platform-eu1',
        ]);
    });

    it('pluralises workloads and joins the namespaces', () => {
        expect(runsInParts({ namespaces: ['argocd', 'monitoring'], workloadCount: 5 }, 'platform-eu1')).toEqual([
            'argocd, monitoring',
            '5 workloads',
            'platform-eu1',
        ]);
    });

    it('folds namespaces past the third into "+N more", and leaves out an unknown cluster', () => {
        expect(runsInParts({ namespaces: ['a', 'b', 'c', 'd', 'e'], workloadCount: 12 }, null)).toEqual([
            'a, b, c +2 more',
            '12 workloads',
        ]);
    });
});
