import { Router } from "express";
import { feedController } from "../controllers/feed.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", feedController.getFeed);

// The Dashboard's "New on running images" block — the scan and move events, folded per image.
router.get("/movement", feedController.movement);
// One row unfolded: which findings arrived on that image in the same window.
router.get("/movement/:imageId/findings", feedController.movementFindings);

export default router;
