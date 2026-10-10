import { Router } from "express";
import { organizationController } from "../controllers/organization.controller.js";
import { requireAuth, requireInternal } from "../middleware/auth.js";

const router = Router();

/**
 * Invite acceptance routes (partially public)
 */

// GET /api/invites/:token - Get invite details (public - for invite page).
// Deliberately unauthenticated: the invited user has no session yet, the
// token itself is the capability, and the handler never reads req.auth.
router.get("/:token", organizationController.getInviteByToken);

// POST /api/invites/:token/accept - Accept invite (requires a signed-in user;
// accepting adds req.auth.userId as a member, so an API key can never accept)
router.post("/:token/accept", requireAuth, requireInternal, organizationController.acceptInvite);

export default router;
