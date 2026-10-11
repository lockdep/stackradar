import { Router } from "express";
import { namespaceController } from "../controllers/namespace.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", namespaceController.getAll);

export default router;
