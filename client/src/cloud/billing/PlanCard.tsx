// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
'use client';

import { Check, Lock, Ticket } from 'lucide-react';
import { Button } from '@/components/ui';
import { PLAN_LIMITS } from '@/components/organization-settings/constants';
import { PLAN_DETAILS, formatDollars, priceView, type BillingInterval, type PlanSlots } from './pricing';

/** The plans the cards draw: the three the cloud sells. */
type PlanType = keyof typeof PLAN_DETAILS;

interface PlanCardProps {
    plan: PlanType;
    /** Monthly or annual — the price the paid cards show and the checkout buys. */
    interval: BillingInterval;
    /** The plan's live beta-slot count; null while unknown (the offer renders without a count). */
    slots: PlanSlots | null;
    isCurrentPlan: boolean;
    onSelect: (plan: PlanType) => void;
    isUpgrade: boolean;
    /** Paid orgs change plans in the billing portal, not via checkout. */
    viaPortal: boolean;
    /** Exactly one card in the grid is recommended: the next tier up from the current plan. */
    isRecommended?: boolean;
    isLoading?: boolean; // this card's action is in progress — shows spinner
    isAnyLoading?: boolean; // any card's action is in progress — disables button
    /** The live demo: the comparison stays, the select button goes. */
    readOnly?: boolean;
}

/**
 * Bolds the quantity in a feature line — "Up to **5 clusters**", "**1 year**
 * of history", "**Unlimited** images". Mirrors the marketing site's
 * `PricingSection`, so both surfaces read as the same pricing table.
 */
const QUANTITY = /^(Up to )?(Unlimited|\d+(?: (?:clusters?|users?|team members|days?|years?))?)(.*)$/;

function FeatureLabel({ text }: { text: string }) {
    const match = QUANTITY.exec(text);
    if (!match) return <>{text}</>;
    const [, prefix, quantity, rest] = match;
    return (
        <>
            {prefix}
            <strong className="font-semibold text-ink">{quantity}</strong>
            {rest}
        </>
    );
}

export function PlanCard({
    plan,
    interval,
    slots,
    isCurrentPlan,
    onSelect,
    isUpgrade,
    viaPortal,
    isRecommended,
    isLoading,
    isAnyLoading,
    readOnly = false,
}: PlanCardProps) {
    const details = PLAN_DETAILS[plan];
    const limits = PLAN_LIMITS[plan];
    // Paid tiers carry the beta-pricing value block; Free renders the same
    // five rows with all but the price invisible so the feature lists start
    // at the same height on every card.
    const view = plan === 'free' ? null : priceView(plan, interval, slots);
    const highlighted = isRecommended && !isCurrentPlan;

    // One visual hierarchy: the recommended card is the only one that shouts.
    // The current plan gets a quiet accent outline; everything else is flat.
    const cardClass = highlighted
        ? 'ring-2 ring-accent-emphasis shadow-floating bg-surface-raised'
        : isCurrentPlan
          ? 'ring-1 ring-accent-emphasis bg-accent-subtle/40'
          : 'ring-1 ring-edge bg-surface-raised';

    const badge = isCurrentPlan
        ? { label: 'Current plan', className: 'bg-neutral-emphasis' }
        : highlighted
          ? { label: 'Recommended', className: 'bg-accent-emphasis' }
          : null;

    const features = [
        limits.clusters === 1 ? '1 cluster' : `Up to ${limits.clusters} clusters`,
        plan === 'free' ? 'Unlimited images — your whole cluster' : 'Unlimited images',
        limits.members === 1 ? '1 user' : `Up to ${limits.members} team members`,
        'Daily CVE re-checks',
        `${limits.retention} of history & saved SBOMs`,
        plan === 'free' ? 'Weekly email digest' : 'Critical & KEV alerts to email and Slack',
        ...(plan === 'team' ? ['Priority support'] : []),
    ];

    return (
        <div className={`relative flex flex-col rounded-md p-6 ${cardClass}`}>
            {badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide text-on-emphasis whitespace-nowrap ${badge.className}`}
                    >
                        {badge.label}
                    </span>
                </div>
            )}

            <h3 className="text-lg font-semibold text-ink">{details.name}</h3>

            {view ? (
                /* The value block, in reading order: the struck standard
                   price (labelled so it is never mistaken for a past price)
                   → the beta price, in accent, as the hero → the saving →
                   the lock → the slot counter. Once the slots are gone the
                   strike disappears and the standard price is the hero. */
                <div className="mt-3">
                    <p className="flex min-h-6 items-center gap-x-2">
                        {view.strike != null ? (
                            <>
                                <span className="text-base font-medium text-ink-faint line-through">
                                    {formatDollars(view.strike)}
                                </span>
                                <span className="text-xs text-ink-faint">after the beta slots</span>
                            </>
                        ) : (
                            <span className="text-xs text-ink-faint">Standard price</span>
                        )}
                        {view.saving && (
                            <span className="ml-auto inline-flex items-center whitespace-nowrap rounded-md bg-accent-subtle px-2 py-0.5 text-xs font-semibold text-accent">
                                {view.saving}
                            </span>
                        )}
                    </p>
                    <p className="mt-1 flex items-baseline gap-x-1.5">
                        <span
                            className={`text-4xl font-bold tracking-tight ${view.book === 'beta' ? 'text-accent' : 'text-ink'}`}
                        >
                            {formatDollars(view.amount)}
                        </span>
                        <span className="text-sm font-medium text-ink-muted">/month</span>
                    </p>
                    <p
                        className={`mt-1 text-xs text-ink-faint ${view.billed ? '' : 'invisible'}`}
                        aria-hidden={!view.billed}
                    >
                        {view.billed || '\u00a0'}
                    </p>
                    <p className="mt-3 flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-ink-muted">
                        <Lock className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                        {view.book === 'beta' ? 'Price locked for as long as you subscribe' : 'Cancel anytime'}
                    </p>
                    <p
                        className={`mt-1.5 flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${view.book === 'beta' ? 'text-accent' : 'text-ink-muted'}`}
                    >
                        <Ticket className="size-3.5 shrink-0" aria-hidden="true" />
                        {view.slotsLine}
                    </p>
                </div>
            ) : (
                /* Same five rows as the paid cards with all but the price
                   invisible, so the tiers can be compared line by line. */
                <div className="mt-3">
                    <p className="invisible flex min-h-6 items-center text-base" aria-hidden="true">
                        &nbsp;
                    </p>
                    <p className="mt-1 flex items-baseline gap-x-1.5 text-ink">
                        <span className="text-4xl font-bold tracking-tight">{PLAN_DETAILS.free.price}</span>
                    </p>
                    <p className="invisible mt-1 text-xs" aria-hidden="true">
                        &nbsp;
                    </p>
                    <p className="invisible mt-3 flex items-center text-xs font-medium" aria-hidden="true">
                        &nbsp;
                    </p>
                    <p className="invisible mt-1.5 flex items-center text-xs font-medium" aria-hidden="true">
                        &nbsp;
                    </p>
                </div>
            )}

            <p className="mt-4 text-sm text-ink-muted">{details.description}</p>

            <ul className="mt-6 space-y-3">
                {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3">
                        <Check className="size-5 shrink-0 text-accent" aria-hidden="true" />
                        <span className="text-sm text-ink-muted">
                            <FeatureLabel text={feature} />
                        </span>
                    </li>
                ))}
            </ul>

            {/* Every card ends in the same slot so the grid's bottoms line up. */}
            <div className="mt-auto pt-6">
                {readOnly && !isCurrentPlan ? (
                    <p className="invisible text-center text-xs" aria-hidden="true">
                        &nbsp;
                    </p>
                ) : isCurrentPlan ? (
                    <>
                        <Button variant="secondary" size="lg" fullWidth disabled>
                            Your current plan
                        </Button>
                        <p className="invisible mt-2 text-center text-xs" aria-hidden="true">
                            &nbsp;
                        </p>
                    </>
                ) : (
                    <>
                        <Button
                            variant={isUpgrade ? 'primary' : 'secondary'}
                            size="lg"
                            fullWidth
                            onClick={() => onSelect(plan)}
                            disabled={isAnyLoading}
                            loading={isLoading}
                        >
                            {!isUpgrade
                                ? `Downgrade to ${details.name}`
                                : viaPortal
                                  ? 'Change plan'
                                  : `Upgrade to ${details.name}`}
                        </Button>
                        <p className="mt-2 text-center text-xs text-ink-muted">
                            {isUpgrade && !viaPortal
                                ? 'Cancel anytime. No lock-in.'
                                : 'Changed through the billing portal.'}
                        </p>
                    </>
                )}
            </div>
        </div>
    );
}
