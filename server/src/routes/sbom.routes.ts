import { Router } from "express";
import { sbomController } from "../controllers/sbom.controller.js";
import { requireAuth, requireInternal, requireOrg } from "../middleware/auth.js";

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

export default router;
