import { Router } from "express";
import { userController } from "../controllers/user.controller.js";
import { requireAuth, requireInternal } from "../middleware/auth.js";
import { requireMultiOrg } from "../middleware/edition.js";

const router = Router();

/*
 * Internal-only, and previously unguarded: these handlers read `x-user-id`
 * straight off the request, and without `requireAuth` + `requireInternal`
 * anyone could act as any user by typing the header. The gate proves the
 * request came through the BFF (which validated the session and set the
 * header) before the controller trusts it.
 */
router.use(requireAuth, requireInternal);

/**
 * GET /api/users/organization
 * Get the current user's organization
 */
router.get("/organization", userController.getOrganization);

/**
 * GET /api/users/organizations
 * Get all organizations the user belongs to
 */
router.get("/organizations", userController.getOrganizations);

/**
 * POST /api/users/setup
 * Set up a new user with a default organization
 * Called by the client when a new user signs up via Auth.js
 */
router.post("/setup", userController.setup);

/**
 * POST /api/users/organizations
 * Create a new organization for the current user. The community edition
 * has exactly one organisation (step 03 of the open-source plan), so there
 * the route answers 403 before the controller runs.
 */
router.post("/organizations", requireMultiOrg, userController.createOrganization);

/* `GET /api/users/terms` and `POST /api/users/terms/accept` are the cloud's
   (`cloud/terms/`): nothing asks a self-hoster to accept terms. */

export default router;

