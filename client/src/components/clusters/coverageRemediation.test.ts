import { describe, expect, it } from 'vitest';
import { resolveEdition } from '@/lib/edition';
import {
    classifyRow,
    createRegistrySecretCommand,
    dockerConfigHelmCommand,
    dockerConfigValuesYaml,
    groupByImage,
    pullSecretHelmCommand,
    pullSecretKnowledge,
    pullSecretValuesYaml,
    scannerInstallFor,
    STUCK_AFTER_MS,
    type UnscannedContainer,
} from './coverageRemediation';

const NOW = Date.parse('2026-10-18T20:00:00Z');
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;

function row(overrides: Partial<UnscannedContainer> = {}): UnscannedContainer {
    return {
        namespace: 'apps',
        workloadName: 'api',
        workloadKind: 'Deployment',
        containerName: 'api',
        imageRef: `registry.example.com/acme/api@${DIGEST_A}`,
        imageDigest: DIGEST_A,
        firstSeenAt: new Date(NOW - 60_000).toISOString(),
        lastSeenAt: new Date(NOW).toISOString(),
        scanErrorCode: null,
        scanErrorHost: null,
        scanErrorAt: null,
        imagePullSecrets: null,
        ...overrides,
    };
}

const authFailed = (overrides: Partial<UnscannedContainer> = {}) =>
    row({ scanErrorCode: 'registry_auth', scanErrorHost: 'registry.example.com', ...overrides });

describe('classifyRow', () => {
    it('lets a reported reason outrank the elapsed-time heuristic', () => {
        expect(classifyRow(authFailed(), NOW)).toBe('auth_failed');
        expect(classifyRow(row({ scanErrorCode: 'registry_rate_limited' }), NOW)).toBe('rate_limited');
        expect(classifyRow(row({ scanErrorCode: 'scan_error' }), NOW)).toBe('scan_failed');
        // An unknown code from a newer scanner is a generic failure, never a specific state.
        expect(classifyRow(row({ scanErrorCode: 'registry_teapot' }), NOW)).toBe('scan_failed');
    });

    it('calls an unexplained wait stuck only past the threshold', () => {
        expect(classifyRow(row(), NOW)).toBe('waiting');
        const old = row({ firstSeenAt: new Date(NOW - STUCK_AFTER_MS).toISOString() });
        expect(classifyRow(old, NOW)).toBe('stuck');
    });
});

describe('groupByImage', () => {
    it('folds every container on one digest into one line, keeping the oldest sighting', () => {
        const older = new Date(NOW - 3_600_000).toISOString();
        const rows = [
            authFailed({ workloadName: 'daily-1' }),
            authFailed({ workloadName: 'daily-2', firstSeenAt: older }),
            authFailed({ workloadName: 'site', namespace: 'web', imageDigest: DIGEST_B }),
        ].map((workload) => ({ workload, status: classifyRow(workload, NOW) }));

        const groups = groupByImage(rows);
        expect(groups).toHaveLength(2);
        expect(groups[0]!.containers.map((c) => c.workloadName)).toEqual(['daily-1', 'daily-2']);
        expect(groups[0]!.firstSeenAt).toBe(older);
        expect(groups[1]!.namespaces).toEqual(['web']);
    });

    it('keeps one digest in two states apart, worst first', () => {
        const rows = [
            { workload: row(), status: 'waiting' as const },
            { workload: authFailed(), status: 'auth_failed' as const },
        ];
        expect(groupByImage(rows).map((g) => g.status)).toEqual(['auth_failed', 'waiting']);
    });

    it('lists the namespaces an image is missing from, once each', () => {
        const rows = [
            authFailed({ namespace: 'a' }),
            authFailed({ namespace: 'b' }),
            authFailed({ namespace: 'a', workloadName: 'other' }),
        ].map((workload) => ({ workload, status: 'auth_failed' as const }));
        expect(groupByImage(rows)[0]!.namespaces).toEqual(['a', 'b']);
    });
});

describe('pullSecretKnowledge', () => {
    it('names the union of the Secrets the pods carry, sorted', () => {
        const k = pullSecretKnowledge([
            authFailed({ imagePullSecrets: ['registry-acme', 'regcred'] }),
            authFailed({ imagePullSecrets: ['regcred'] }),
            authFailed({ imagePullSecrets: null }),
        ]);
        expect(k).toEqual({ kind: 'named', names: ['regcred', 'registry-acme'] });
    });

    it('is "none" only when every container reported an empty list', () => {
        expect(pullSecretKnowledge([authFailed({ imagePullSecrets: [] })])).toEqual({ kind: 'none' });
    });

    it('never turns "not reported" into "none"', () => {
        expect(pullSecretKnowledge([authFailed({ imagePullSecrets: null })])).toEqual({ kind: 'unknown' });
        expect(pullSecretKnowledge([authFailed({ imagePullSecrets: [] }), authFailed()])).toEqual({ kind: 'unknown' });
        expect(pullSecretKnowledge([])).toEqual({ kind: 'unknown' });
    });
});

describe('scannerInstallFor', () => {
    it('is the bundled subchart in the community edition and the standalone chart in the cloud', () => {
        expect(scannerInstallFor(resolveEdition('community'), '0.5.0')).toEqual({ kind: 'bundled' });
        expect(scannerInstallFor(resolveEdition('cloud'), '0.5.0')).toEqual({
            kind: 'standalone',
            chartVersion: '0.5.0',
        });
    });
});

describe('the pull-Secret fix', () => {
    const names = ['registry-acme', 'regcred'];

    it('nests the values under the subchart alias for a bundled scanner', () => {
        expect(pullSecretValuesYaml({ kind: 'bundled' }, names)).toBe(
            [
                'scanner:',
                '  scanner:',
                '    resolveImagePullSecrets: true',
                '    imagePullSecretNames:',
                '      - registry-acme',
                '      - regcred',
            ].join('\n'),
        );
        const cmd = pullSecretHelmCommand({ kind: 'bundled' }, names);
        expect(cmd).toContain('helm upgrade stackradar oci://ghcr.io/lockdep/helm-charts/stackradar');
        expect(cmd).toContain('--version <chart-version>');
        expect(cmd).toContain('--set-string scanner.scanner.resolveImagePullSecrets=true');
        expect(cmd).toContain("--set 'scanner.scanner.imagePullSecretNames={registry-acme,regcred}'");
    });

    it('targets the standalone chart at its installed version', () => {
        const install = { kind: 'standalone' as const, chartVersion: '0.6.0' };
        expect(pullSecretValuesYaml(install, names)).toBe(
            [
                'scanner:',
                '  resolveImagePullSecrets: true',
                '  imagePullSecretNames:',
                '    - registry-acme',
                '    - regcred',
            ].join('\n'),
        );
        const cmd = pullSecretHelmCommand(install, names);
        expect(cmd).toContain('helm upgrade stackradar-scanner oci://ghcr.io/lockdep/charts/stackradar-scanner');
        expect(cmd).toContain('--version 0.6.0');
        expect(cmd).toContain('--set-string scanner.resolveImagePullSecrets=true');
        expect(cmd).toContain("--set 'scanner.imagePullSecretNames={registry-acme,regcred}'");
    });

    it('leaves a placeholder when the names are not known', () => {
        expect(pullSecretValuesYaml({ kind: 'bundled' }, [])).toContain('- <secret-name>');
        expect(pullSecretHelmCommand({ kind: 'standalone', chartVersion: null }, [])).toContain('{<secret-name>}');
        expect(pullSecretHelmCommand({ kind: 'standalone', chartVersion: null }, [])).toContain(
            '--version <chart-version>',
        );
    });
});

describe('the own-credential fix', () => {
    it('creates the Secret in the scanner namespace for the failing host and points the chart at it', () => {
        const create = createRegistrySecretCommand({ kind: 'bundled' }, 'registry.example.com');
        expect(create).toContain('kubectl create secret docker-registry stackradar-registry');
        expect(create).toContain('--namespace stackradar');
        expect(create).toContain('--docker-server=registry.example.com');

        expect(dockerConfigValuesYaml({ kind: 'bundled' })).toBe('scanner:\n  dockerConfigSecret: stackradar-registry');
        expect(dockerConfigValuesYaml({ kind: 'standalone', chartVersion: null })).toBe(
            'dockerConfigSecret: stackradar-registry',
        );
        expect(dockerConfigHelmCommand({ kind: 'bundled' })).toContain(
            '--set scanner.dockerConfigSecret=stackradar-registry',
        );
        expect(dockerConfigHelmCommand({ kind: 'standalone', chartVersion: '0.6.0' })).toContain(
            '--set dockerConfigSecret=stackradar-registry',
        );
    });
});
