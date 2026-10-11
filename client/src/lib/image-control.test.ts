import { describe, expect, it } from 'vitest';
import {
    changesToSave,
    controlReason,
    hasUnaskedRepositories,
    repositoryKey,
    type RepositoryControl,
} from './image-control';

const repo = (overrides: Partial<RepositoryControl> & { repository: string }): RepositoryControl => ({
    registry: 'docker.io',
    control: 'unknown',
    detected: { control: 'unknown', detectedBy: null, detail: null },
    rule: null,
    source: null,
    imageCount: 1,
    containerCount: 1,
    ...overrides,
});

const worker = repo({ repository: 'acme/worker' });
const api = repo({
    registry: 'registry.corp.example',
    repository: 'team/api',
    control: 'built',
    detected: { control: 'built', detectedBy: 'private-registry', detail: 'registry.corp.example' },
});
const prometheus = repo({
    registry: 'quay.io',
    repository: 'prometheus/prometheus',
    control: 'third-party',
    detected: { control: 'third-party', detectedBy: 'chart', detail: 'kube-prometheus-stack' },
});

describe('changesToSave', () => {
    it('writes nothing for repositories left as detected', () => {
        expect(changesToSave([api, prometheus], new Map())).toEqual([]);
    });

    it('writes a rule only for the rows the reader changed', () => {
        const ticked = new Map([[repositoryKey(prometheus), true]]);
        expect(changesToSave([api, prometheus], ticked)).toEqual([
            { registry: 'quay.io', repository: 'prometheus/prometheus', control: 'built' },
        ]);
    });

    it('answers every unconfirmed repository, ticked or not — so none is asked about twice', () => {
        const ticked = new Map([[repositoryKey(worker), true]]);
        const other = repo({ repository: 'acme/other' });
        expect(changesToSave([worker, other], ticked)).toEqual([
            { registry: 'docker.io', repository: 'acme/worker', control: 'built' },
            { registry: 'docker.io', repository: 'acme/other', control: 'third-party' },
        ]);
    });

    it('drops the rule rather than restating what was detected', () => {
        const overridden = {
            ...prometheus,
            control: 'built' as const,
            rule: { control: 'built' as const, reason: null, createdByEmail: null, updatedAt: '' },
        };
        const ticked = new Map([[repositoryKey(overridden), false]]);
        expect(changesToSave([overridden], ticked)).toEqual([
            { registry: 'quay.io', repository: 'prometheus/prometheus', control: null },
        ]);
    });
});

describe('the card', () => {
    it('asks only while an unconfirmed repository has not been dismissed', () => {
        expect(hasUnaskedRepositories([api, prometheus], new Set())).toBe(false);
        expect(hasUnaskedRepositories([api, worker], new Set())).toBe(true);
        expect(hasUnaskedRepositories([api, worker], new Set([repositoryKey(worker)]))).toBe(false);
        // A new repository brings it back.
        expect(
            hasUnaskedRepositories([worker, repo({ repository: 'acme/new' })], new Set([repositoryKey(worker)])),
        ).toBe(true);
    });
});

describe('controlReason', () => {
    it('says why in the reader\'s words, never "built" or "unknown"', () => {
        const all = [
            controlReason('private-registry', 'registry.corp.example'),
            controlReason('chart', 'kube-prometheus-stack'),
            controlReason('official-image', null),
            controlReason('public-registry', 'docker.io/library'),
            controlReason(null, null),
        ];
        expect(all[1]).toBe('delivered by chart kube-prometheus-stack');
        expect(all[0]).toBe('private registry');
        for (const text of all) expect(text).not.toMatch(/\bbuilt\b|\bunknown\b/);
    });
});
