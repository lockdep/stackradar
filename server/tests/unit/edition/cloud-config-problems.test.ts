import { describe, it, expect } from "vitest";
import { cloudConfigProblems } from "../../../src/config/index.js";

const full = { stripe: { secretKey: "sk", webhookSecret: "whsec" }, email: { resendApiKey: "re", webhookSecret: "whsec" } };
const empty = { stripe: { secretKey: "", webhookSecret: "" }, email: { resendApiKey: "", webhookSecret: "" } };
const cloud = { billing: true, alerting: "full" as const };
const community = { billing: false, alerting: "webhook" as const };

/**
 * The readiness probe's configuration check: on the cloud a missing Stripe
 * key keeps the pod out of rotation, a missing Resend key is reported; in
 * the community edition none of it applies.
 */
describe("cloudConfigProblems", () => {
    it("reports nothing for a fully configured cloud", () => {
        expect(cloudConfigProblems(full, cloud)).toEqual({ blocking: [], warnings: [] });
    });

    it("blocks the cloud on missing Stripe secrets, naming the variable and never its value", () => {
        const problems = cloudConfigProblems({ ...full, stripe: empty.stripe }, cloud);
        expect(problems.blocking).toEqual(["STRIPE_SECRET_KEY is not set", "STRIPE_WEBHOOK_SECRET is not set"]);
        expect(problems.warnings).toEqual([]);
    });

    it("warns the cloud about missing Resend secrets without blocking", () => {
        const problems = cloudConfigProblems({ ...full, email: empty.email }, cloud);
        expect(problems.blocking).toEqual([]);
        expect(problems.warnings).toHaveLength(2);
        expect(problems.warnings[0]).toContain("RESEND_API_KEY");
    });

    it("has nothing to say in the community edition, whatever is unset", () => {
        expect(cloudConfigProblems(empty, community)).toEqual({ blocking: [], warnings: [] });
    });
});
