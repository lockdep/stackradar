import { Router } from "express";
import { radarScoreController } from "../controllers/radar-score.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

/*
 * The org-wide Radar Score breakdown — every cluster's Radar Score tab
 * folded into one, scoped by the caller's org rather than a path parameter,
 * as `/vulnerabilities` is of the Vulnerabilities tabs. Same parameters and
 * shapes as `/clusters/:id/radar-score` and its `/findings`.
 */
router.use(requireAuth, requireInternal, requireOrg);

// Every scanned image's share of the org's Radar Score, largest first (paginated)
router.get("/", radarScoreController.images);

// The findings that add up to one image's share (the expand-row drill-down)
router.get("/findings", radarScoreController.findings);

export default router;
