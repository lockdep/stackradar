import { Router } from "express";
import { searchController } from "../controllers/search.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

/*
 * The global search — one org-scoped request behind the ⌘K palette. Tenant
 * data throughout: every group is filtered by the caller's org, and the
 * advisory direct hit is only ever an advisory the org's fleet carries.
 */
router.use(requireAuth, requireInternal, requireOrg);

router.get("/", searchController.search);

export default router;
