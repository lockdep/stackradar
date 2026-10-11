import { Router } from "express";
import { releaseController } from "../controllers/release.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", releaseController.getAll);
router.get("/:id", releaseController.getById);
router.get("/:id/upgrade", releaseController.getUpgrade);

export default router;
