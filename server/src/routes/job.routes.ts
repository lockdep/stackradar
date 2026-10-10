import { Router } from "express";
import { jobController } from "../controllers/job.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

// List and stats
router.get("/", jobController.getAll);
router.get("/stats", jobController.getStats);

// Individual job operations. Deliberately read-only plus lifecycle: there is
// no user-facing way to *create* a job. Scans are queued by the system —
// on SBOM upload, and fleet-wide after every mirror-changing OSV sync
// (`osv-sync/rescan.ts`) — so a manual trigger could only duplicate work
// that is already scheduled, and exposing one made every authenticated user
// a load generator against the matcher.
router.get("/:id", jobController.getById);

// Job lifecycle actions
router.post("/:id/cancel", jobController.cancel);
router.post("/:id/retry", jobController.retry);

export default router;
