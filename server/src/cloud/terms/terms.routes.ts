// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { Router } from "express";
import { requireAuth, requireInternal } from "../../middleware/auth.js";
import { termsController } from "./terms.controller.js";

/*
 * Mounted at `/api/users/terms` by `cloud/index.ts`. Internal-only, like
 * the rest of `/api/users`: the handlers trust the BFF-set `x-user-id`.
 */
const router = Router();

router.use(requireAuth, requireInternal);

/** GET /api/users/terms — the user's standing (required vs accepted version). */
router.get("/", termsController.status);

/** POST /api/users/terms/accept — record acceptance of the current version. */
router.post("/accept", termsController.accept);

export default router;
