import { Router } from "express";
import { imageController } from "../controllers/image.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", imageController.getAll);
router.get("/:id", imageController.getById);
router.get("/:id/upgrade", imageController.getUpgrade);
router.get("/:id/base-upgrade", imageController.getBaseUpgrade);
router.get("/:id/deployments", imageController.getDeployments);
router.get("/:id/vulnerabilities/grouped", imageController.getVulnerabilitiesGrouped);
router.get("/:id/vulnerabilities", imageController.vulnerabilities);
router.get("/:id/vulnerabilities/occurrences", imageController.vulnerabilityOccurrences);
router.get("/:id/vulnerabilities/detail", imageController.vulnerabilityDetail);

export default router;
