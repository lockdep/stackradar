// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveEdition } from '@/lib/edition';
import { planState } from './plan-state';

/**
 * The plan chooser a new organization sees before anything else, and the
 * rule that decides when it shows. Static markup: the chooser's fetches
 * (slot counts, trial eligibility) never run on the server render, so what
 * is asserted is the shape — two paid cards, no Free card, the trial line.
 */
vi.mock('next-auth/react', () => ({ signOut: () => {} }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {} }) }));
vi.mock('@/components/providers', () => ({
    useOrganization: () => ({ organization: null, isLoading: true, updateOrganization: () => {} }),
}));
vi.stubGlobal('window', { location: { search: '', origin: 'http://localhost:3000' } });

const { PlanGateScreen } = await import('./PlanGate');

const org = { id: 'org-1', name: 'Acme', slug: 'acme', plan: 'free', stripeSubscriptionStatus: null };

describe('PlanGateScreen', () => {
    it('offers the two paid plans with the trial as the call to action, and no Free plan', () => {
        const html = renderToStaticMarkup(<PlanGateScreen organization={org} />);
        expect(html).toContain('Start your 14-day free trial');
        expect(html).toContain('>Pro<');
        expect(html).toContain('>Business<');
        expect(html).not.toContain('>Free<');
        expect(html).not.toContain('No plan');
        expect((html.match(/Start free trial/g) ?? []).length).toBe(2);
        expect(html).toContain('14-day free trial · card required · nothing charged until it ends');
        expect(html).toContain('Community Edition');
        expect(html).toContain('Sign out');
    });
});

describe('planState', () => {
    const cloud = resolveEdition('cloud');
    const community = resolveEdition('community');

    it('a new org has never had a plan: the chooser', () => {
        expect(planState({ plan: 'free', stripeSubscriptionStatus: null }, cloud)).toBe('never');
        expect(planState({ plan: 'free' }, cloud)).toBe('never');
    });

    it('an org whose plan ended keeps the final status: lapsed, read-only', () => {
        expect(planState({ plan: 'free', stripeSubscriptionStatus: 'canceled' }, cloud)).toBe('lapsed');
        expect(planState({ plan: 'free', stripeSubscriptionStatus: 'unpaid' }, cloud)).toBe('lapsed');
    });

    it('a trialing or paying org is active, whatever the status says', () => {
        expect(planState({ plan: 'pro', stripeSubscriptionStatus: 'trialing' }, cloud)).toBe('active');
        expect(planState({ plan: 'team', stripeSubscriptionStatus: 'past_due' }, cloud)).toBe('active');
    });

    it('the community edition has no plans and is never gated', () => {
        expect(planState({ plan: 'free', stripeSubscriptionStatus: null }, community)).toBe('active');
        expect(planState({ plan: 'free', stripeSubscriptionStatus: 'canceled' }, community)).toBe('active');
    });
});
