import type { Request, Response, NextFunction } from "express";
import { AppError } from "../middleware/error-handler.js";
import { organizationRepository, userRepository } from "../repositories/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { createUserOrgSchema } from "../schemas/index.js";
import { cloudHooks } from "../lib/cloud-hooks.js";
import { edition } from "../edition.js";
import { db } from "../db/index.js";
import { ensureDefaultOrganization } from "../services/default-org.service.js";

const log = createLogger("user.controller");

export const userController = {
  /**
   * Get the current user's organization
   * Returns the first organization the user belongs to (typically their default org)
   *
   * @route GET /api/users/organization
   * @returns {Object} 200 - Organization details
   * @returns {Error} 404 - No organization found
   */
  async getOrganization(req: Request, res: Response, next: NextFunction) {
    // requireAuth + requireInternal already proved this is a BFF request
    // acting as a user, so userId is present on the internal auth branch.
    const userId = req.auth!.userId!;

    try {
      const time = createQueryTimer(log, { userId });
      const orgs = await time("getUserOrganizations", organizationRepository.getUserOrganizations(userId));

      if (orgs.length === 0) {
        throw new AppError(404, "No organization found");
      }

      // Return the first org (users default org)
      const org = orgs[0]!;
      res.json({
        organization: {
          id: org.id,
          name: org.name,
          slug: org.slug,
          color: org.color,
          plan: org.plan,
          stripeSubscriptionStatus: org.stripeSubscriptionStatus,
          stripeCurrentPeriodEnd: org.stripeCurrentPeriodEnd,
          stripeCancelAt: org.stripeCancelAt,
        },
      });
    } catch (error) {
      log.error({ err: error, userId }, "Failed to get user organization");
      next(error);
    }
  },

  /**
   * Get all organizations the current user belongs to
   *
   * @route GET /api/users/organizations
   * @returns {Object} 200 - List of organizations
   */
  async getOrganizations(req: Request, res: Response, next: NextFunction) {
    // Present via requireAuth + requireInternal, as above.
    const userId = req.auth!.userId!;

    try {
      const time = createQueryTimer(log, { userId });
      const orgs = await time("getUserOrganizations", organizationRepository.getUserOrganizations(userId));

      res.json({
        organizations: orgs.map((org) => ({
          id: org.id,
          name: org.name,
          slug: org.slug,
          color: org.color,
          plan: org.plan,
          role: org.role,
          // The findings view this org's tables open on (`useTierLens`' fallback).
          defaultFindingTier: org.defaultFindingTier,
          stripeSubscriptionStatus: org.stripeSubscriptionStatus,
          stripeCurrentPeriodEnd: org.stripeCurrentPeriodEnd,
          stripeCancelAt: org.stripeCancelAt,
        })),
      });
    } catch (error) {
      log.error({ err: error, userId }, "Failed to get user organizations");
      next(error);
    }
  },

  /**
   * Set up a new user with a default organization
   * Called by the client when a new user signs up via Auth.js
   *
   * @route POST /api/users/setup
   * @returns {Object} 201 - Created organization details
   * @returns {Error} 500 - Failed to create organization
   *
   * Identity comes from `req.auth` (the BFF-verified session headers), never
   * from the body (security review S6): a body-supplied `userId`/`userEmail`
   * would let any caller that reaches this endpoint upsert-overwrite another
   * user's email via `ensureUserExists`. The body is ignored entirely.
   */
  async setup(req: Request, res: Response, next: NextFunction) {
    // requireAuth + requireInternal are mounted on the router, so `auth` is
    // present and is the internal variant.
    const auth = req.auth!;
    const userId = auth.userId!;
    const userEmail = auth.user!.email;
    const userName = auth.user!.name;
    const rawUserId = userId;
    const rawUserEmail = userEmail;

    try {
      const time = createQueryTimer(log, { userId });

      // Ensure user exists in server database (synced from Auth.js client database)
      const user = await time("ensureUserExists", userRepository.ensureUserExists({
        id: userId,
        email: userEmail,
        name: userName ?? null,
      }));

      // The cloud records the login page's terms acceptance here (its
      // `onUserSeen` hook); the community edition has no terms to accept.
      await time("cloudUserSeen", cloudHooks.onUserSeen({ id: userId }));

      // Check if user already has an organization
      const existingOrgs = await time("getUserOrganizations", organizationRepository.getUserOrganizations(userId));
      if (existingOrgs.length > 0) {
        // User already set up, return existing org
        const org = existingOrgs[0]!;
        res.json({
          message: "User already set up",
          organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            color: org.color,
            plan: org.plan,
            role: org.role,
            stripeSubscriptionStatus: org.stripeSubscriptionStatus,
            stripeCurrentPeriodEnd: org.stripeCurrentPeriodEnd,
            stripeCancelAt: org.stripeCancelAt,
          },
        });
        return;
      }

      // The community edition's single-organisation rule, in one place: no
      // organisation is created for anyone. The first account to sign in
      // owns the default organisation (seeded at start-up by
      // `ensureDefaultOrganization`; re-ensured here so a login that races
      // the seed, or a test, finds it), every later account joins it as a
      // member, and none of the cloud's sign-up side effects (terms,
      // welcome email, attribution) happen — not because their hooks are
      // absent, but because nothing was signed up for.
      if (!edition.multiOrg) {
        const { orgId } = await time("ensureDefaultOrganization", ensureDefaultOrganization());
        const role = await time("joinDefaultOrganization", db.transaction(async (tx) => {
          // Two first logins at once must not both find "no owner".
          await organizationRepository.lockOrganization(orgId, tx);
          const role = (await organizationRepository.hasOwner(orgId, tx)) ? "member" : "owner";
          await organizationRepository.addOrgMember(orgId, userId, role, tx);
          return role;
        }));
        const org = (await time("getOrganizationById", organizationRepository.getOrganizationById(orgId)))!;
        log.info({ userId, orgId, role }, "Joined the default organization");

        res.status(201).json({
          message: "User setup complete",
          organization: {
            id: org.id,
            name: org.name,
            slug: org.slug,
            color: org.color,
            plan: org.plan,
            role,
            stripeSubscriptionStatus: org.stripeSubscriptionStatus,
            stripeCurrentPeriodEnd: org.stripeCurrentPeriodEnd,
            stripeCancelAt: org.stripeCancelAt,
          },
        });
        return;
      }

      // Generate organization name from user's name or email
      const orgName = userName
        ? `${userName}'s Organization`
        : `${userEmail.split("@")[0]}'s Organization`;

      // Create the default organization with the user as owner
      const organization = await time("createOrganization", organizationRepository.createOrganization({
        name: orgName,
        ownerId: userId,
      }));

      log.info({ userId, orgName, userEmail }, "Created default organization for user");

      // The cloud's sign-up side effects — the org's terms acceptance, the
      // welcome email, the sign-up attribution and the funnel events it
      // drives — live behind `onSignup` (`cloud/hooks.ts`). The raw body
      // goes along because the attribution rides in it; the hook validates
      // what it reads and never throws, so none of it can fail setup. In
      // the community edition the hook is absent and nothing happens.
      await time("cloudSignup", cloudHooks.onSignup(
        { user: { id: user.id, email: user.email, name: user.name, isNew: user.isNew }, org: { id: organization.id, name: organization.name } },
        req.body
      ));

      res.status(201).json({
        message: "User setup complete",
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          color: organization.color,
          plan: organization.plan,
          // The creator is the owner by construction (createOrganization
          // inserts the membership row); the client gates the cluster
          // wizard on this, so it must be present on first login.
          role: "owner",
          stripeSubscriptionStatus: organization.stripeSubscriptionStatus,
          stripeCurrentPeriodEnd: organization.stripeCurrentPeriodEnd,
          stripeCancelAt: organization.stripeCancelAt,
        },
      });
    } catch (error) {
      log.error({ err: error, userId: rawUserId, userEmail: rawUserEmail }, "Failed to set up user");
      next(error);
    }
  },

  /**
   * Create a new organization for the current user
   *
   * @route POST /api/users/organizations
   * @param {string} req.body.name - Organization name
   * @returns {Object} 201 - Created organization details
   * @returns {Error} 400 - Validation failed
   * @returns {Error} 401 - User ID required
   * @returns {Error} 409 - User already belongs to a free organization (code FREE_ORG_LIMIT)
   */
  async createOrganization(req: Request, res: Response, next: NextFunction) {
    // Present via requireAuth + requireInternal, as above.
    const userId = req.auth!.userId!;

    try {
      const { name } = createUserOrgSchema.parse(req.body);
      const time = createQueryTimer(log, { userId });

      // One free org per user. New orgs always start on the free plan, so a
      // user already in a free org would otherwise get a second free cluster
      // slot just by creating another org. Upgrading or deleting the
      // existing free org frees the slot.
      if (await time("hasFreeOrganization", organizationRepository.hasFreeOrganization(userId))) {
        throw new AppError(
          409,
          "You already have a free organization. Upgrade it to add more clusters, or delete it to start a new one.",
          true,
          "FREE_ORG_LIMIT",
        );
      }

      const organization = await time("createOrganization", organizationRepository.createOrganization({
        name,
        ownerId: userId,
      }));

      // The cloud binds the creator's terms acceptance to each org they create.
      await time("cloudOrganizationCreated", cloudHooks.onOrganizationCreated({ orgId: organization.id, userId }));

      log.info({ userId, orgName: name, orgId: organization.id }, "Created new organization");

      res.status(201).json({
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          color: organization.color,
          plan: organization.plan,
          role: "owner",
        },
      });
    } catch (error) {
      log.error({ err: error, userId }, "Failed to create organization");
      next(error);
    }
  },
};
