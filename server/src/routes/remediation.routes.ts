import { Router } from "express";
import { remediationController } from "../controllers/remediation.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/rollup", remediationController.getRollup);
// The Fixes page — the rollup's suggestion feed as one ranked, read-only list.
router.get("/fixes", remediationController.getFixes);
router.get("/images/:id", remediationController.getImageDetail);

router.get("/issues", remediationController.getIssues);
router.post("/issues", remediationController.createIssue);
router.get("/issues/:id", remediationController.getIssueDetail);
router.patch("/issues/:id", remediationController.transitionIssue);

router.get("/suppressions", remediationController.getSuppressions);
router.post("/suppressions", remediationController.createSuppression);
router.delete("/suppressions/:id", remediationController.deleteSuppression);

router.get("/activity", remediationController.getActivity);

export default router;
