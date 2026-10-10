import { Router } from "express";
import { requireAuth, requireInternal, requireAdmin } from "../middleware/auth.js";
import { adminController } from "../controllers/admin.controller.js";

const router = Router();

router.get("/stats", requireAuth, requireInternal, requireAdmin, adminController.getStats);
router.get("/jobs", requireAuth, requireInternal, requireAdmin, adminController.getJobs);
router.get("/overview", requireAuth, requireInternal, requireAdmin, adminController.getOverview);
router.get("/organizations", requireAuth, requireInternal, requireAdmin, adminController.getOrganizations);
router.get("/organizations/:orgId/clusters", requireAuth, requireInternal, requireAdmin, adminController.getOrgClusters);
router.get("/organizations/:orgId/containers", requireAuth, requireInternal, requireAdmin, adminController.getOrgContainers);
/* Old name, kept for one release like `/api/workloads` in index.ts. Remove once
   the container-named client is on prod. */
router.get("/organizations/:orgId/workloads", requireAuth, requireInternal, requireAdmin, adminController.getOrgContainers);
router.get("/images", requireAuth, requireInternal, requireAdmin, adminController.getImages);
router.get("/vulnerabilities", requireAuth, requireInternal, requireAdmin, adminController.getVulnerabilities);
router.get("/matcher", requireAuth, requireInternal, requireAdmin, adminController.getMatcher);
router.get("/explorer/images", requireAuth, requireInternal, requireAdmin, adminController.getExplorerImages);
router.get("/explorer/sboms", requireAuth, requireInternal, requireAdmin, adminController.getExplorerSboms);
router.get("/explorer/components", requireAuth, requireInternal, requireAdmin, adminController.getExplorerComponents);
router.get("/explorer/components/:componentId", requireAuth, requireInternal, requireAdmin, adminController.getExplorerComponentDetail);
router.get("/osv", requireAuth, requireInternal, requireAdmin, adminController.getOsv);
router.get("/feeds", requireAuth, requireInternal, requireAdmin, adminController.getFeeds);
router.get("/osv/parse-failures", requireAuth, requireInternal, requireAdmin, adminController.listParseFailures);
router.get("/osv/parse-failures/:id", requireAuth, requireInternal, requireAdmin, adminController.getParseFailure);
router.get("/osv/parse-failures/:id/raw", requireAuth, requireInternal, requireAdmin, adminController.getParseFailureRaw);
router.delete("/osv/parse-failures", requireAuth, requireInternal, requireAdmin, adminController.clearParseFailures);

export default router;
