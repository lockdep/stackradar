import { Router } from "express";
import { sbomController } from "../controllers/sbom.controller.js";
import { requireAuth, requireInternal, requireOrg, requireScope } from "../middleware/auth.js";
import { rateLimitByApiKey } from "../middleware/rate-limit.js";

// Same per-key ceiling as the canonical /v1 mount (S8) — a separate bucket,
// but a key hammering both mounts is bounded by each.
const sbomUploadLimit = rateLimitByApiKey({ capacity: 60, refillPerMinute: 30, name: "SBOM upload" });

const router = Router();

/*
 * An SBOM describes an image, and `images` carries no tenant — so every read
 * here needs an organisation to scope against, and the handler proves the org
 * runs the digest before answering. `requireOrg` is what makes `req.auth.orgId`
 * non-empty for those checks; without it `GET`/`DELETE /api/sboms/:id` fell
 * through to a bare `findById`, and a UUID was the only thing standing between
 * one tenant and another's component list. See `db/tenancy.ts`.
 */
router.get("/", requireAuth, requireInternal, requireOrg, sbomController.getAll);
router.get("/:id", requireAuth, requireInternal, requireOrg, sbomController.getById);
// The stored CycloneDX document, inline or (`?download=1`) as an attachment.
router.get("/:id/document", requireAuth, requireInternal, requireOrg, sbomController.getDocument);
router.delete("/:id", requireAuth, requireInternal, requireOrg, sbomController.delete);

/*
 * The scanner's write path — the same handler `/v1/sboms/upload/cyclonedx`
 * mounts. No `requireInternal`: this is one of the few endpoints API keys are
 * *for*. `requireScope` is what makes the key's `scopes` column real; the
 * handler itself insists on a cluster-scoped key (ADR 0006).
 */
router.post("/upload/cyclonedx", requireAuth, requireScope("sbom:write"), sbomUploadLimit, sbomController.uploadCycloneDx);

export default router;
