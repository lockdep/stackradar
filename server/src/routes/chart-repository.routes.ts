import { Router } from "express";
import { chartRepositoryController } from "../controllers/chart-repository.controller.js";
import { requireAdminOrOwner, requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

// Reads are member-accessible; mutations are admin/owner-only — this surface
// lives in Organization Settings, which the UI presents as admin territory.
router.get("/", chartRepositoryController.list);
router.post("/", requireAdminOrOwner, chartRepositoryController.create);
/* Static path before `/:id`, or "discover" parses as an id. */
router.get("/discover", chartRepositoryController.discover);
router.patch("/:id", requireAdminOrOwner, chartRepositoryController.update);
router.delete("/:id", requireAdminOrOwner, chartRepositoryController.delete);
router.post("/:id/refresh", requireAdminOrOwner, chartRepositoryController.refresh);

export default router;
