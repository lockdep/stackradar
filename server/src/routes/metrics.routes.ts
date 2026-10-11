import { Router } from "express";
import { metricsController } from "../controllers/metrics.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/snapshots", metricsController.listSnapshots);
router.post("/snapshots", metricsController.triggerCapture);

router.get("/clusters/:clusterId/snapshots", metricsController.listClusterSnapshots);
router.post("/clusters/:clusterId/snapshots", metricsController.triggerClusterCapture);

export default router;
