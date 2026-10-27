// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlanCard } from './PlanCard';

/**
 * The billing tab's cards, which are where the checkout and portal buttons
 * live. `readOnly` is the live demo: the comparison is kept — the demo org
 * is on Business, and the point is to show what the tiers are — but no card
 * offers a button that would open Stripe for a shared visitor account. The
 * cloud sells two plans; there is no card for "no plan".
 */
const render = (readOnly: boolean) =>
    renderToStaticMarkup(
        <>
            <PlanCard
                plan="pro"
                interval="month"
                slots={null}
                isCurrentPlan={false}
                isUpgrade={false}
                viaPortal
                onSelect={() => {}}
                readOnly={readOnly}
            />
            <PlanCard
                plan="team"
                interval="month"
                slots={null}
                isCurrentPlan
                isUpgrade={false}
                viaPortal
                onSelect={() => {}}
                readOnly={readOnly}
            />
        </>,
    );

const renderPro = (props: Partial<Parameters<typeof PlanCard>[0]>) =>
    renderToStaticMarkup(
        <PlanCard
            plan="pro"
            interval="month"
            slots={null}
            isCurrentPlan={false}
            isUpgrade
            viaPortal={false}
            onSelect={() => {}}
            {...props}
        />,
    );

describe('PlanCard', () => {
    it('shows the beta offer without a count until the slot count is known', () => {
        const html = renderPro({ slots: null });
        expect(html).toContain('10 slots left at beta price');
        expect(html).toContain('$59');
        expect(html).toContain('$99');
        expect(html).toContain('after the beta slots');
        expect(html).toContain('Price locked');
    });

    it('counts down the beta slots once some are taken', () => {
        const html = renderPro({ slots: { total: 10, claimed: 3 } });
        expect(html).toContain('7 slots left at beta price');
        expect(html).toContain('Save $40/mo');
    });

    it('uses the singular for the last slot', () => {
        expect(renderPro({ slots: { total: 10, claimed: 9 } })).toContain('1 slot left at beta price');
    });

    it('sells the standard price, unstruck, once the slots are gone', () => {
        const html = renderPro({ slots: { total: 10, claimed: 10 } });
        expect(html).toContain('No slots left at beta price');
        expect(html).toContain('$99');
        expect(html).not.toContain('line-through');
        expect(html).not.toContain('Price locked');
    });

    it('shows annual as a per-month figure with the yearly total billed underneath, on either book', () => {
        const beta = renderPro({ interval: 'year' });
        expect(beta).toContain('$49');
        expect(beta).toContain('$590 /yr');
        expect(beta).toContain('Save 17%');
        expect(beta).toContain('$83'); // the standard price, struck, on the same per-month basis
        const standard = renderPro({ interval: 'year', slots: { total: 10, claimed: 10 } });
        expect(standard).toContain('$83');
        expect(standard).toContain('$990 /yr');
    });

    it('shows no yearly total under a monthly price', () => {
        expect(renderPro({})).not.toContain('/yr');
    });

    it('offers the change-plan buttons when not read-only', () => {
        const html = render(false);
        expect(html).toContain('Downgrade to Pro');
        expect(html).toContain('Your current plan');
    });

    it("takes the chooser's wording for the button and the line under it", () => {
        const html = renderPro({ ctaLabel: 'Start free trial', ctaNote: '14 days free · card required' });
        expect(html).toContain('Start free trial');
        expect(html).toContain('14 days free · card required');
        expect(html).not.toContain('Upgrade to Pro');
    });

    it('keeps the comparison but drops every plan-change button when read-only', () => {
        const html = render(true);
        expect(html).not.toContain('Downgrade to');
        expect(html).not.toContain('Change plan');
        expect(html).not.toContain('Upgrade to');
        expect(html).toContain('Your current plan');
        // The tiers are still described.
        expect(html).toContain('Business');
        expect(html).toContain('Pro');
    });
});
