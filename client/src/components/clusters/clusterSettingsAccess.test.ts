import { describe, expect, it } from 'vitest';
import type { Organization } from '@/components/providers';
import { clusterSettingsAccess } from './clusterSettingsAccess';

const org = (role: Organization['role']) => ({ id: 'org-1', name: 'Acme', slug: 'acme', role }) as Organization;

describe('clusterSettingsAccess', () => {
    it('lets admins and owners manage outside the demo', () => {
        expect(clusterSettingsAccess(org('owner'), false)).toBe('manage');
        expect(clusterSettingsAccess(org('admin'), false)).toBe('manage');
    });

    it('draws nothing for a member outside the demo', () => {
        expect(clusterSettingsAccess(org('member'), false)).toBe('none');
        expect(clusterSettingsAccess(null, false)).toBe('none');
    });

    it('is read-only in the demo, whatever the role', () => {
        // The demo visitor is drawn as a member (`viewerRole`); this is the
        // one place a member sees the Settings tab, and only to look.
        expect(clusterSettingsAccess(org('member'), true)).toBe('read-only');
        expect(clusterSettingsAccess(org('owner'), true)).toBe('read-only');
    });
});
