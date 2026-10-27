// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { Router } from "express";
import { billingController } from "./billing.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../../middleware/auth.js";
import { allowWithoutPlan } from "../../lib/plan-gate.js";

const router = Router();

// The way back in: an org without a plan is read-only everywhere else
// (`lib/plan-gate.ts`), and checkout is how it gets one.
router.use(allowWithoutPlan);

// POST /api/billing/checkout — create Stripe Checkout session
router.post("/checkout", requireAuth, requireInternal, requireOrg, billingController.createCheckout);

// POST /api/billing/portal — create Stripe Customer Portal session
router.post("/portal", requireAuth, requireInternal, requireOrg, billingController.createPortal);

// GET /api/billing/pricing — beta-price slot counts for the Billing tab
// (the same payload the public /v1/pricing serves the marketing site)
router.get("/pricing", requireAuth, requireInternal, billingController.pricing);

export default router;
