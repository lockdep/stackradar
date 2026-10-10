import { Router } from "express";
import { gitopsApplicationController } from "../controllers/gitops-application.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", gitopsApplicationController.getAll);

export default router;
