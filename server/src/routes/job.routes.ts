import { Router } from "express";
import { jobController } from "../controllers/job.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

const router = Router();

router.use(requireAuth, requireInternal, requireOrg);

router.get("/", jobController.getAll);

// Deliberately read-only: there is no user-facing way to create, cancel or
// retry a job. Scans are queued by the system — on SBOM upload, and
// fleet-wide after every mirror-changing OSV sync (`osv-sync/rescan.ts`) —
// so a manual trigger could only duplicate work that is already scheduled,
// and exposing one made every authenticated user a load generator against
// the matcher. The client polls `/:id` for a chart-repository refresh job.
router.get("/:id", jobController.getById);

export default router;
