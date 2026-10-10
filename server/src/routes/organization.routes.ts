import { Router } from "express";
import { organizationController } from "../controllers/organization.controller.js";
import { imageControlController } from "../controllers/image-control.controller.js";
import { tierRulesController } from "../controllers/tier-rules.controller.js";
import { alertsController } from "../controllers/alerts.controller.js";
import { requireAuth, requireInternal } from "../middleware/auth.js";

const router = Router();

/**
 * Organization settings routes.
 *
 * All internal-only: these are management endpoints, and the role checks in
 * the controller (`requireAdminOrOwner`) resolve `req.auth.userId` — which
 * only internal (BFF) requests carry. API keys are machine credentials for
 * the scanner ingest surface and have no business here.
 */
router.use(requireAuth, requireInternal);

// GET /api/organizations/:id - Get organization details with role
router.get("/:id", organizationController.getOrganization);

// PATCH /api/organizations/:id - Update organization settings (admin+)
router.patch("/:id", organizationController.updateOrganization);

// DELETE /api/organizations/:id - Delete organization (owner only)
router.delete("/:id", organizationController.deleteOrganization);

/**
 * Member management routes
 */

// Critical & KEV alerts — owners and admins; Pro and Business only for writes.
// GET   /api/organizations/:id/alerts      Settings, recipients, recent deliveries
// PATCH /api/organizations/:id/alerts      Email on/off, Slack webhook set/remove
// POST  /api/organizations/:id/alerts/test Send a test on every channel that is on
router.get("/:id/alerts", alertsController.get);
router.patch("/:id/alerts", alertsController.update);
router.post("/:id/alerts/test", alertsController.test);

// GET /api/organizations/:id/members - List all members
router.get("/:id/members", organizationController.getMembers);

// PATCH /api/organizations/:id/members/:userId - Update member role (admin+)
router.patch("/:id/members/:userId", organizationController.updateMemberRole);

// DELETE /api/organizations/:id/members/:userId - Remove member (admin+)
router.delete("/:id/members/:userId", organizationController.removeMember);

// POST /api/organizations/:id/leave - Leave organization (self)
router.post("/:id/leave", organizationController.leaveOrganization);

/**
 * Usage & Billing routes
 */

// GET /api/organizations/:id/usage - Get usage statistics for billing
router.get("/:id/usage", organizationController.getUsage);

/**
 * Invite management routes
 */

// GET /api/organizations/:id/invites - List pending invites (admin+)
router.get("/:id/invites", organizationController.getInvites);

// POST /api/organizations/:id/invites - Create invite (admin+)
router.post("/:id/invites", organizationController.createInvite);

// DELETE /api/organizations/:id/invites/:inviteId - Cancel invite (admin+)
router.delete("/:id/invites/:inviteId", organizationController.cancelInvite);

/**
 * Image ownership — who controls each image repository (admin+)
 */

// GET /api/organizations/:id/image-control - Repositories with detected and chosen control
router.get("/:id/image-control", imageControlController.list);

// PUT /api/organizations/:id/image-control-rules - Set, change or reset the org's answers
router.put("/:id/image-control-rules", imageControlController.putRules);

/**
 * Findings views — which packages are "Application" and which "Base image" (admin+)
 */

// GET /api/organizations/:id/tier-rules - The org's override rules, with what each touches
router.get("/:id/tier-rules", tierRulesController.list);

// POST /api/organizations/:id/tier-rules - Add a rule; queues a reclassification of this org
router.post("/:id/tier-rules", tierRulesController.create);

// DELETE /api/organizations/:id/tier-rules/:ruleId - Remove a rule; queues the same
router.delete("/:id/tier-rules/:ruleId", tierRulesController.remove);

export default router;
