import { Router } from "express";
import { sbomController } from "../controllers/sbom.controller.js";
import { scannerController } from "../controllers/scanner.controller.js";
import { requireAuth, requireScope } from "../middleware/auth.js";
import { rateLimitByApiKey } from "../middleware/rate-limit.js";

/*
 * Per-key ingest limits (S8). Sized for a real scanner: an initial scan of a
 * large cluster bursts SBOM uploads (bucket of 60, sustained 30/min); the
 * inventory report is one POST per scan cycle (bucket of 5, sustained
 * 2/min). Both far above legitimate traffic, both far below what it takes to
 * hurt the worker or the database.
 */
const sbomUploadLimit = rateLimitByApiKey({ capacity: 60, refillPerMinute: 30, name: "SBOM upload" });
const inventoryLimit = rateLimitByApiKey({ capacity: 5, refillPerMinute: 2, name: "inventory report" });

const router = Router();

/*
 * The scanner ingest surface — the only endpoints that accept API keys.
 * `requireScope("sbom:write")` enforces the key's `scopes` column (internal
 * requests pass it implicitly); each handler additionally requires the key to
 * be cluster-scoped (ADR 0006). Everything under `/api` is `requireInternal`.
 *
 * The rest of `/v1` — the Stripe and Resend webhooks, the digest and alert
 * unsubscribe links, the pricing counter — is the cloud's, mounted by
 * `cloud/index.ts` when the edition has it. A new `/v1` path also needs the
 * hosted ingress allow-list updated, or it answers 404 before reaching here.
 */
router.post("/heartbeat", requireAuth, requireScope("sbom:write"), scannerController.heartbeat);
router.post("/inventory", requireAuth, requireScope("sbom:write"), inventoryLimit, scannerController.reportInventory);
router.post(
    "/sboms/upload/cyclonedx",
    requireAuth,
    requireScope("sbom:write"),
    sbomUploadLimit,
    sbomController.uploadCycloneDx,
);
router.get("/sboms/check", requireAuth, requireScope("sbom:write"), sbomController.check);

export default router;
