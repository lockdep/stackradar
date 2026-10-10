// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { z } from "zod";

// ============================================================================
// Billing schemas — request validation for /api/billing
// ============================================================================

export const createCheckoutSchema = z.object({
    /**
     * Which paid tier to check out. Anything that is not "team" degrades to
     * "pro" rather than 400 — the behaviour the controller has always had —
     * so a stale client can never be locked out of upgrading.
     */
    plan: z.enum(["pro", "team"]).catch("pro").default("pro"),
    /**
     * Monthly or annual billing (annual is ten months' price). Same
     * degrade-to-default policy as `plan`: an unknown value is a monthly
     * checkout, never a 400.
     */
    interval: z.enum(["month", "year"]).catch("month").default("month"),
    successUrl: z.string("successUrl and cancelUrl are required").min(1, "successUrl and cancelUrl are required"),
    cancelUrl: z.string("successUrl and cancelUrl are required").min(1, "successUrl and cancelUrl are required"),
});

export const createPortalSchema = z.object({
    returnUrl: z.string("returnUrl is required").min(1, "returnUrl is required"),
});
