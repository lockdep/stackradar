import { Router } from "express";
import { remediationController } from "../controllers/remediation.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

// The dashboard's "Fix these first" block — the suggestion feed as one ranked, read-only list.
router.get("/fixes", remediationController.getFixes);

export default router;
