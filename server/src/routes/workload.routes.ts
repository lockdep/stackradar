import { Router } from "express";
import { loadContainer, workloadController } from "../controllers/workload.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

// Every workload endpoint touches tenant data — authentication and an
// organisation context are mandatory, and `loadContainer` checks that the
// container in the path belongs to the caller's org before any handler runs.
router.use(requireAuth, requireInternal, requireOrg);
router.param("id", loadContainer);

router.get("/", workloadController.getAll);
router.get("/:id", workloadController.getById);
router.get("/:id/siblings", workloadController.getSiblings);
router.get("/:id/vulnerabilities/grouped", workloadController.getVulnerabilitiesGrouped);
router.get("/:id/exposure", workloadController.getExposure);
router.get("/:id/vulnerabilities", workloadController.getVulnerabilities);
router.get("/:id/dependencies/overview", workloadController.getDependenciesOverview);
router.get("/:id/sboms", workloadController.getSboms);
router.get("/:id/scan-history", workloadController.getScanHistory);

// No POST, PUT or DELETE. Workloads are discovered through `POST /v1/inventory`,
// not authored — see `workload.controller.ts`.

export default router;
