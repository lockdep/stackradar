import { Router } from "express";
import { riskScoreController } from "../controllers/risk-score.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

/*
 * The org-wide Risk Score breakdown — every cluster's Risk Score tab
 * folded into one, scoped by the caller's org rather than a path parameter,
 * as `/vulnerabilities` is of the Vulnerabilities tabs. Same parameters and
 * shapes as `/clusters/:id/risk-score` and its `/findings`.
 */
router.use(requireAuth, requireInternal, requireOrg);

// Every scanned image's share of the org's Risk Score, largest first (paginated)
router.get("/", riskScoreController.images);

// The findings that add up to one image's share (the expand-row drill-down)
router.get("/findings", riskScoreController.findings);

export default router;
