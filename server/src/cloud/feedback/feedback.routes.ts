// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { Router } from "express";
import { requireAuth, requireInternal, requireAdmin } from "../../middleware/auth.js";
import { feedbackController } from "./feedback.controller.js";

const router = Router();

/*
 * Internal-only: the handler trusts the BFF-set `x-user-id` header, so the
 * gate must prove the request came through the BFF (see user.routes.ts).
 * Reading feedback back is an admin surface — that lives in admin.routes.ts.
 */
router.use(requireAuth, requireInternal);

/**
 * POST /api/feedback
 * Store a feedback message from the signed-in user.
 */
router.post("/", feedbackController.create);

export default router;

/** `GET /api/admin/feedback` — the founder's inbox, platform admins only. */
export const adminFeedbackRoutes = Router();
adminFeedbackRoutes.get("/", requireAuth, requireInternal, requireAdmin, feedbackController.list);
