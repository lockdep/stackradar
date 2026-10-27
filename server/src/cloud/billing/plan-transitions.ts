// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import type Stripe from "stripe";
import type { Organization } from "../../db/schema/index.js";
import type { PaidPlan } from "./plans.js";
import { organizationRepository } from "../../repositories/organization.repository.js";
import { userRepository } from "../../repositories/user.repository.js";
import { posthogService, type ServerEventName } from "../../services/posthog.service.js";
import { founderAlertService } from "../attribution/founder-alert.service.js";
import { config } from "../../config/index.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("plan-transitions");

/**
 * The moments in a subscription's life the product reports on. Derived by
 * {@link classifyPlanTransition} from the org row the webhook is about to
 * replace and the subscription it is replacing it with — never from the
 * event's own type, which `syncPlanForCustomer` deliberately does not trust.
 */
export type PlanTransition = "trial_started" | "trial_converted" | "trial_cancelled" | "plan_ended";

/** The slice of the stored org row a transition is read against. */
export type PreviousPlanState = Pick<
    Organization,
    "plan" | "stripeSubscriptionId" | "stripeSubscriptionStatus" | "stripeCancelAt"
>;

/** The slice of a Stripe subscription a transition is read from. */
export interface NextSubscription {
    id: string;
    status: Stripe.Subscription.Status;
    cancel_at: number | null;
}

/**
 * Which transitions moving `prev` to `next` represents. Pure, so the rules
 * can be read in one place and tested without Stripe:
 *
 * - **trial_started** — the current subscription is `trialing` and it was
 *   not this subscription trialing before (a new checkout, or a lapsed org
 *   whose owner started again).
 * - **trial_cancelled** — a trialing subscription gained a `cancel_at`
 *   (the portal's cancel, which during a trial means "end unpaid"), or a
 *   trialing subscription ended without one having been scheduled.
 * - **trial_converted** — the same subscription went from `trialing` to
 *   `active`: the card was charged.
 * - **plan_ended** — the org had a plan and now has none, however that
 *   happened (cancelled, unpaid, deleted).
 *
 * `trialing → past_due` is not a transition: the card failed at conversion
 * and Stripe is retrying; the org stays paid (`PAID_STATUSES`) and the
 * outcome arrives later as `active` or as the end of the plan.
 */
export function classifyPlanTransition(prev: PreviousPlanState, next: NextSubscription | null): PlanTransition[] {
    const wasTrialing = prev.stripeSubscriptionStatus === "trialing";
    const sameSubscription = next !== null && prev.stripeSubscriptionId === next.id;
    const out: PlanTransition[] = [];

    if (next === null) {
        if (prev.plan !== "free") {
            if (wasTrialing && !prev.stripeCancelAt) out.push("trial_cancelled");
            out.push("plan_ended");
        }
        return out;
    }

    if (next.status === "trialing") {
        if (!(wasTrialing && sameSubscription)) {
            out.push("trial_started");
        } else if (next.cancel_at && !prev.stripeCancelAt) {
            out.push("trial_cancelled");
        }
        return out;
    }

    if (next.status === "active" && wasTrialing && sameSubscription) {
        out.push("trial_converted");
    }
    return out;
}

/** What a subscription says about itself, for the events' properties. */
function describe(subscription: Stripe.Subscription, plan: PaidPlan): Record<string, string | null> {
    const price = subscription.items.data[0]?.price;
    return {
        plan,
        interval: price?.recurring?.interval ?? null,
        price_book: subscription.metadata?.["priceBook"] ?? null,
        trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    };
}

/**
 * The side effects of the transitions the webhook just recorded. Called
 * after the org row is written and never awaited by the webhook: an
 * analytics or mail outage must not fail — or delay — the plan update
 * Stripe is waiting on. Every sender below is one that never throws; this
 * catches anyway, because a webhook retry storm over a logging bug would be
 * the worst possible failure mode.
 *
 * - `trial_started` stamps `users.trial_consumed_at` on the person who
 *   checked out (the subscription's `metadata.userId`, falling back to the
 *   org's owner), which is what makes the trial one-per-person; sends the
 *   founder alert; captures the PostHog event.
 * - `trial_converted` sends the founder alert and captures the event.
 * - `trial_cancelled` and `plan_ended` capture the event.
 *
 * PostHog's `distinct_id` is the org id, as every server-side event's is
 * (`services/posthog.service.ts`), so the sign-up funnel can end on
 * `trial_started` and a `trial_started → trial_converted` funnel reads
 * off the same person.
 */
export function emitPlanTransitions(input: {
    org: Pick<Organization, "id" | "name">;
    transitions: PlanTransition[];
    subscription: Stripe.Subscription | null;
    plan: PaidPlan | "free";
    now?: Date;
}): void {
    if (input.transitions.length === 0) return;
    const now = input.now ?? new Date();
    void (async () => {
        for (const transition of input.transitions) {
            await emitOne(transition, input.org, input.subscription, input.plan, now);
        }
    })().catch((err) => log.error({ err, orgId: input.org.id }, "Plan transition side effects failed"));
}

async function emitOne(
    transition: PlanTransition,
    org: Pick<Organization, "id" | "name">,
    subscription: Stripe.Subscription | null,
    plan: PaidPlan | "free",
    now: Date,
): Promise<void> {
    const properties: Record<string, unknown> = { org_id: org.id };
    if (subscription && plan !== "free") Object.assign(properties, describe(subscription, plan));
    else properties["plan"] = plan;

    if (transition === "trial_started" && subscription && plan !== "free") {
        const person = await resolvePerson(org.id, subscription);
        if (person) {
            const startedAt = subscription.trial_start ? new Date(subscription.trial_start * 1000) : now;
            await userRepository.markTrialConsumed(person.id, startedAt);
            log.info({ orgId: org.id, userId: person.id }, "Trial consumed");
        } else {
            log.warn({ orgId: org.id, subscriptionId: subscription.id }, "Trial started for an org with no owner");
        }
        await founderAlertService.notifyTrial({
            kind: "started",
            person: person ? { email: person.email, name: person.name } : null,
            org,
            plan,
            interval: subscription.items.data[0]?.price?.recurring?.interval ?? null,
            priceBook: subscription.metadata?.["priceBook"] ?? null,
            trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
            subscriptionId: subscription.id,
            adminUrl: `${config.appUrl}/admin`,
        });
    }

    if (transition === "trial_converted" && subscription && plan !== "free") {
        const person = await resolvePerson(org.id, subscription);
        await founderAlertService.notifyTrial({
            kind: "converted",
            person: person ? { email: person.email, name: person.name } : null,
            org,
            plan,
            interval: subscription.items.data[0]?.price?.recurring?.interval ?? null,
            priceBook: subscription.metadata?.["priceBook"] ?? null,
            trialEnd: null,
            subscriptionId: subscription.id,
            adminUrl: `${config.appUrl}/admin`,
        });
    }

    const event: ServerEventName = transition;
    await posthogService.capture({ event, distinctId: org.id, timestamp: now, properties });
}

/**
 * Who the trial belongs to: the person who checked out, named by the
 * subscription's metadata, or failing that the org's owner. A metadata id
 * that resolves to no user (a deleted account) falls through to the owner.
 */
async function resolvePerson(
    orgId: string,
    subscription: Stripe.Subscription,
): Promise<{ id: string; email: string; name: string | null } | null> {
    const fromMetadata = subscription.metadata?.["userId"];
    if (fromMetadata) {
        const user = await userRepository.getUserById(fromMetadata);
        if (user) return { id: user.id, email: user.email, name: user.name };
    }
    return organizationRepository.getOwner(orgId);
}
