import { Router } from "express";
import { requireAuth, requireInternal, requireAdmin } from "../middleware/auth.js";
import { adminController } from "../controllers/admin.controller.js";

const router = Router();

router.get("/jobs", requireAuth, requireInternal, requireAdmin, adminController.getJobs);
router.get("/overview", requireAuth, requireInternal, requireAdmin, adminController.getOverview);
router.get("/system", requireAuth, requireInternal, requireAdmin, adminController.getSystem);
router.get("/organizations", requireAuth, requireInternal, requireAdmin, adminController.getOrganizations);
router.get(
    "/organizations/:orgId/clusters",
    requireAuth,
    requireInternal,
    requireAdmin,
    adminController.getOrgClusters,
);
router.get(
    "/organizations/:orgId/containers",
    requireAuth,
    requireInternal,
    requireAdmin,
    adminController.getOrgContainers,
);
router.get("/images", requireAuth, requireInternal, requireAdmin, adminController.getImages);
router.get("/vulnerabilities", requireAuth, requireInternal, requireAdmin, adminController.getVulnerabilities);
router.get("/matcher", requireAuth, requireInternal, requireAdmin, adminController.getMatcher);
router.get("/explorer/images", requireAuth, requireInternal, requireAdmin, adminController.getExplorerImages);
router.get("/explorer/sboms", requireAuth, requireInternal, requireAdmin, adminController.getExplorerSboms);
router.get("/explorer/components", requireAuth, requireInternal, requireAdmin, adminController.getExplorerComponents);
router.get(
    "/explorer/components/:componentId",
    requireAuth,
    requireInternal,
    requireAdmin,
    adminController.getExplorerComponentDetail,
);
router.get("/osv", requireAuth, requireInternal, requireAdmin, adminController.getOsv);
router.get("/feeds", requireAuth, requireInternal, requireAdmin, adminController.getFeeds);
router.get("/osv/parse-failures", requireAuth, requireInternal, requireAdmin, adminController.listParseFailures);
router.get("/osv/parse-failures/:id", requireAuth, requireInternal, requireAdmin, adminController.getParseFailure);
router.get(
    "/osv/parse-failures/:id/raw",
    requireAuth,
    requireInternal,
    requireAdmin,
    adminController.getParseFailureRaw,
);
router.delete("/osv/parse-failures", requireAuth, requireInternal, requireAdmin, adminController.clearParseFailures);

// Actions (`services/admin-actions.service.ts`): each runs the existing
// code path behind the lock it already takes, refuses while the same action
// is in progress, and is logged with the acting admin. 202 for a run started
// in the background, 200 for one that finished in the request, 409 for one
// already running or one the topology cannot run from here.
router.post("/jobs/:id/retry", requireAuth, requireInternal, requireAdmin, adminController.retryJob);
router.post("/jobs/retry-stuck", requireAuth, requireInternal, requireAdmin, adminController.retryStuckJobs);
router.post("/osv/sync", requireAuth, requireInternal, requireAdmin, adminController.triggerOsvSync);
router.post("/osv/bootstrap", requireAuth, requireInternal, requireAdmin, adminController.triggerOsvBootstrap);
router.post("/feeds/:feed/sync", requireAuth, requireInternal, requireAdmin, adminController.triggerFeedSync);
router.post("/images/gc", requireAuth, requireInternal, requireAdmin, adminController.collectImages);
router.post("/rescan", requireAuth, requireInternal, requireAdmin, adminController.rescanFleet);

export default router;
