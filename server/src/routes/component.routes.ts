import { Router } from "express";
import { componentController } from "../controllers/component.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

/*
 * The org-wide package list — every cluster's Packages tab folded into one,
 * scoped by the caller's org rather than a path parameter. Same query
 * parameters and response shapes as `/clusters/:id/components` and its
 * `/occurrences`, so the client renders both with one component. Tenant data
 * throughout: a package is only ever listed through an image the org owns.
 */
router.use(requireAuth, requireInternal, requireOrg);

router.get("/", componentController.list);
router.get("/occurrences", componentController.occurrences);
router.get("/ecosystems", componentController.ecosystems);

export default router;
