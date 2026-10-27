import { describe, it, expect } from "vitest";
import { classifyPlanTransition, type PreviousPlanState } from "../../../src/cloud/billing/plan-transitions.js";

/**
 * The webhook reads the trial events off the org row it is replacing against
 * the subscription Stripe reports now. These are the rules, one case each.
 */
const none: PreviousPlanState = {
    plan: "free",
    stripeSubscriptionId: null,
    stripeSubscriptionStatus: null,
    stripeCancelAt: null,
};
const trialing: PreviousPlanState = {
    plan: "pro",
    stripeSubscriptionId: "sub_1",
    stripeSubscriptionStatus: "trialing",
    stripeCancelAt: null,
};
const active: PreviousPlanState = { ...trialing, stripeSubscriptionStatus: "active" };

describe("classifyPlanTransition", () => {
    it("a new trialing subscription starts a trial", () => {
        expect(classifyPlanTransition(none, { id: "sub_1", status: "trialing", cancel_at: null })).toEqual([
            "trial_started",
        ]);
    });

    it("the same trialing subscription seen again is nothing new", () => {
        expect(classifyPlanTransition(trialing, { id: "sub_1", status: "trialing", cancel_at: null })).toEqual([]);
    });

    it("a lapsed org's owner trialing again (a new subscription) starts a trial", () => {
        const lapsed: PreviousPlanState = { ...none, stripeSubscriptionStatus: "canceled" };
        expect(classifyPlanTransition(lapsed, { id: "sub_2", status: "trialing", cancel_at: null })).toEqual([
            "trial_started",
        ]);
    });

    it("a trialing subscription gaining cancel_at is a cancelled trial", () => {
        expect(classifyPlanTransition(trialing, { id: "sub_1", status: "trialing", cancel_at: 1_800_000_000 })).toEqual(
            ["trial_cancelled"],
        );
        // Seen again with the same cancel_at: already reported.
        const scheduled = { ...trialing, stripeCancelAt: new Date(1_800_000_000 * 1000) };
        expect(
            classifyPlanTransition(scheduled, { id: "sub_1", status: "trialing", cancel_at: 1_800_000_000 }),
        ).toEqual([]);
    });

    it("trialing → active on the same subscription is a conversion", () => {
        expect(classifyPlanTransition(trialing, { id: "sub_1", status: "active", cancel_at: null })).toEqual([
            "trial_converted",
        ]);
    });

    it("trialing → past_due is not a transition (Stripe is retrying the card)", () => {
        expect(classifyPlanTransition(trialing, { id: "sub_1", status: "past_due", cancel_at: null })).toEqual([]);
    });

    it("a trial ending with no cancellation scheduled is cancelled and ended", () => {
        expect(classifyPlanTransition(trialing, null)).toEqual(["trial_cancelled", "plan_ended"]);
    });

    it("a trial ending after its cancellation was scheduled is only ended (the cancel was reported then)", () => {
        const scheduled = { ...trialing, stripeCancelAt: new Date() };
        expect(classifyPlanTransition(scheduled, null)).toEqual(["plan_ended"]);
    });

    it("a paid plan ending is plan_ended", () => {
        expect(classifyPlanTransition(active, null)).toEqual(["plan_ended"]);
    });

    it("an org that never had a plan and still has none is nothing", () => {
        expect(classifyPlanTransition(none, null)).toEqual([]);
    });

    it("active → active (a renewal, a portal change) is nothing", () => {
        expect(classifyPlanTransition(active, { id: "sub_1", status: "active", cancel_at: null })).toEqual([]);
    });
});
