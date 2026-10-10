import type { Request, Response, NextFunction } from "express";
import { getPlanLimits } from "../config/plans.js";
import { buildInviteUrl } from "../lib/invite-url.js";
import { db } from "../db/index.js";
import { organizationRepository, inviteRepository, sbomRepository, clusterRepository, userRepository } from "../repositories/index.js";
import { createLogger, createQueryTimer } from "../lib/logger.js";
import { AppError } from "../middleware/error-handler.js";
import { assertAdminOrOwner } from "../middleware/auth.js";
import type { InviteEmailStatus, OrgInvite, OrgRole } from "../db/schema/index.js";
import { cloudHooks } from "../lib/cloud-hooks.js";
import {
    updateOrgSchema,
    updateMemberRoleSchema,
    createInviteSchema,
} from "../schemas/index.js";

const log = createLogger("organization.controller");

/**
 * Get the current user's role in the organization from request
 */
async function getCurrentUserRole(req: Request, orgId: string): Promise<OrgRole | null> {
    if (!req.auth?.userId) return null;
    return organizationRepository.getUserRole(orgId, req.auth.userId);
}

/**
 * Ensure the user is the owner
 */
async function requireOwner(req: Request, orgId: string): Promise<void> {
    const role = await getCurrentUserRole(req, orgId);
    if (!role || !organizationRepository.isOwner(role)) {
        throw new AppError(403, "Owner role required");
    }
}


/**
 * Send the invite email and persist the outcome on the invite row. Never
 * throws: email is a side effect of the invite, not a precondition. The
 * sending is the cloud's (`sendInviteEmail` in `cloud/hooks.ts`); without
 * it an invite is a link the admin shares by hand, and the row says so.
 */
async function sendInviteEmail(
    invite: OrgInvite,
    ctx: { orgName: string; inviterName: string | null },
): Promise<InviteEmailStatus> {
    const result = await cloudHooks.sendInviteEmail(invite, ctx);
    await inviteRepository.setEmailStatus(invite.id, result.status, result.messageId);
    return result.status;
}

export const organizationController = {
    /**
     * Get organization details with current user's role
     * @route GET /api/organizations/:id
     */
    async getOrganization(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            const time = createQueryTimer(log, { orgId: id });
            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(id));
            if (!org) {
                throw new AppError(404, "Organization not found");
            }

            const role = await time("getUserRole", organizationRepository.getUserRole(id, req.auth?.userId ?? ""));
            if (!role) {
                throw new AppError(403, "Not a member of this organization");
            }

            res.json({
                organization: {
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                    color: org.color,
                    plan: org.plan,
                    weeklyDigestEnabled: org.weeklyDigestEnabled,
                    defaultFindingTier: org.defaultFindingTier,
                    stripeSubscriptionStatus: org.stripeSubscriptionStatus,
                    stripeCurrentPeriodEnd: org.stripeCurrentPeriodEnd,
                    stripeCancelAt: org.stripeCancelAt,
                    createdAt: org.createdAt,
                },
                role,
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Update organization settings
     * @route PATCH /api/organizations/:id
     */
    async updateOrganization(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            await assertAdminOrOwner(req, id);

            const data = updateOrgSchema.parse(req.body);
            if (Object.keys(data).length === 0) {
                throw new AppError(400, "No fields to update");
            }

            const time = createQueryTimer(log, { orgId: id });
            const updated = await time("updateOrganization", organizationRepository.updateOrganization(id, data));
            if (!updated) {
                throw new AppError(404, "Organization not found");
            }

            log.info({ orgId: id, ...data }, "Organization updated");

            res.json({
                organization: {
                    id: updated.id,
                    name: updated.name,
                    slug: updated.slug,
                    color: updated.color,
                    plan: updated.plan,
                    weeklyDigestEnabled: updated.weeklyDigestEnabled,
                    defaultFindingTier: updated.defaultFindingTier,
                },
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Delete organization (owner only)
     * @route DELETE /api/organizations/:id
     */
    async deleteOrganization(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            await requireOwner(req, id);

            const time = createQueryTimer(log, { orgId: id });
            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(id));
            if (!org) throw new AppError(404, "Organization not found");

            // Stop the money first: the cloud's hook cancels the Stripe
            // subscription and clears it from the row, and throws if it
            // could not — which aborts the deletion, because a soft-deleted
            // org is invisible to the webhook that would otherwise stop the
            // billing (see `cancelSubscriptionForOrgDeletion`).
            await time("cloudBeforeDelete", cloudHooks.beforeOrganizationDelete(org));

            await time("deleteOrganization", organizationRepository.deleteOrganization(id));
            log.info({ orgId: id, userId: req.auth?.userId }, "Organization deleted");

            res.json({ message: "Organization deleted" });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get organization members
     * @route GET /api/organizations/:id/members
     */
    async getMembers(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            const role = await getCurrentUserRole(req, id);
            if (!role) {
                throw new AppError(403, "Not a member of this organization");
            }

            const time = createQueryTimer(log, { orgId: id });
            const members = await time("getOrgMembers", organizationRepository.getOrgMembers(id));

            res.json({
                members: members.map((m) => ({
                    id: m.user.id,
                    name: m.user.name,
                    email: m.user.email,
                    image: m.user.image,
                    role: m.role,
                    joinedAt: m.joinedAt,
                })),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Update a member's role
     * @route PATCH /api/organizations/:id/members/:userId
     */
    async updateMemberRole(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            const userId = req.params["userId"]!;

            const currentUserRole = await assertAdminOrOwner(req, id);

            const time = createQueryTimer(log, { orgId: id, targetUserId: userId });

            const targetRole = await time("getUserRole", organizationRepository.getUserRole(id, userId));
            if (!targetRole) {
                throw new AppError(404, "Member not found");
            }

            if (targetRole === "owner") {
                throw new AppError(403, "Cannot change owner's role");
            }

            const data = updateMemberRoleSchema.parse(req.body);
            if (currentUserRole === "admin" && data.role === "admin" && targetRole !== "admin") {
                throw new AppError(403, "Only owner can promote to admin");
            }

            await time("updateMemberRole", organizationRepository.updateMemberRole(id, userId, data.role as OrgRole));
            log.info({ orgId: id, targetUserId: userId, newRole: data.role }, "Member role updated");

            res.json({ message: "Role updated", role: data.role });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Remove a member from the organization
     * @route DELETE /api/organizations/:id/members/:userId
     */
    async removeMember(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            const userId = req.params["userId"]!;

            await assertAdminOrOwner(req, id);

            const time = createQueryTimer(log, { orgId: id, targetUserId: userId });

            const targetRole = await time("getUserRole", organizationRepository.getUserRole(id, userId));
            if (!targetRole) {
                throw new AppError(404, "Member not found");
            }

            if (targetRole === "owner") {
                throw new AppError(403, "The organization owner cannot be removed.");
            }

            await time("removeOrgMember", organizationRepository.removeOrgMember(id, userId));
            log.info({ orgId: id, removedUserId: userId }, "Member removed from organization");

            res.json({ message: "Member removed" });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Leave organization (self)
     * @route POST /api/organizations/:id/leave
     */
    async leaveOrganization(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            if (!req.auth?.userId) {
                throw new AppError(401, "Authentication required");
            }

            const role = await getCurrentUserRole(req, id);
            if (!role) {
                throw new AppError(403, "Not a member of this organization");
            }

            if (role === "owner") {
                throw new AppError(403, "The owner cannot leave the organization. Delete the organization instead.");
            }

            const time = createQueryTimer(log, { orgId: id, userId: req.auth.userId });
            await time("removeOrgMember", organizationRepository.removeOrgMember(id, req.auth.userId));
            log.info({ orgId: id, userId: req.auth.userId }, "User left organization");

            res.json({ message: "Left organization" });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get pending invites for organization
     * @route GET /api/organizations/:id/invites
     */
    async getInvites(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            await assertAdminOrOwner(req, id);

            const time = createQueryTimer(log, { orgId: id });
            const invites = await time("getOrgInvites", inviteRepository.getOrgInvites(id));

            res.json({
                invites: invites.map((i) => ({
                    id: i.invite.id,
                    email: i.invite.email,
                    role: i.invite.role,
                    expiresAt: i.invite.expiresAt,
                    createdAt: i.invite.createdAt,
                    // Admin-only endpoint (assertAdminOrOwner above), so
                    // exposing the shareable link here is intentional.
                    inviteUrl: buildInviteUrl(i.invite.token),
                    // Null when the inviter deleted their account (invited_by
                    // is SET NULL) — the invite itself remains valid.
                    invitedBy: i.invitedByUser
                        ? {
                            id: i.invitedByUser.id,
                            name: i.invitedByUser.name,
                            email: i.invitedByUser.email,
                        }
                        : null,
                })),
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Create a new invite
     * @route POST /api/organizations/:id/invites
     */
    async createInvite(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            if (!req.auth?.userId) {
                throw new AppError(401, "Authentication required");
            }

            await assertAdminOrOwner(req, id);

            const { email, role } = createInviteSchema.parse(req.body);
            const time = createQueryTimer(log, { orgId: id });

            // Enforce member limit for the org's plan. Pending invites count
            // toward the limit too — otherwise N invites created while under
            // the limit could all be accepted and push the org over it.
            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(id));
            if (org) {
                const limits = getPlanLimits(org.plan);
                const memberCount = await time("countMembers", organizationRepository.countMembers(id));
                const pendingInvites = await time("countPendingInvites", inviteRepository.countPendingInvites(id));
                if (memberCount + pendingInvites >= limits.members) {
                    throw new AppError(403, `Your plan allows a maximum of ${limits.members} member(s), including pending invites. Upgrade your plan to add more.`, true, "PLAN_LIMIT_EXCEEDED");
                }
            }

            const isMember = await time("isMemberByEmail", organizationRepository.isMemberByEmail(id, email));
            if (isMember) {
                throw new AppError(400, "User is already a member of this organization");
            }

            const existingInvite = await time("findExistingInvite", inviteRepository.findExistingInvite(id, email));
            if (existingInvite) {
                throw new AppError(400, "An active invite already exists for this email");
            }

            const invite = await time("createInvite", inviteRepository.createInvite({
                orgId: id,
                email,
                role,
                invitedBy: req.auth.userId,
            }));

            log.info({ orgId: id, invitedEmail: email, role }, "Invite created");

            // Email the invitee. The invite is valid regardless of the
            // outcome — inviteUrl is returned so the admin can share the link
            // by hand when email is unconfigured or the send failed.
            const emailStatus = await sendInviteEmail(invite, {
                orgName: org?.name || req.auth.org.name || "your team",
                inviterName: req.auth.user.name || req.auth.user.email,
            });

            res.status(201).json({
                invite: {
                    id: invite.id,
                    email: invite.email,
                    role: invite.role,
                    expiresAt: invite.expiresAt,
                    inviteUrl: buildInviteUrl(invite.token),
                    emailStatus,
                },
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Cancel an invite
     * @route DELETE /api/organizations/:id/invites/:inviteId
     */
    async cancelInvite(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;
            const inviteId = req.params["inviteId"]!;

            await assertAdminOrOwner(req, id);

            const time = createQueryTimer(log, { orgId: id, inviteId });
            const invite = await time("getInviteById", inviteRepository.getInviteById(inviteId));
            if (!invite || invite.orgId !== id) {
                throw new AppError(404, "Invite not found");
            }

            await time("deleteInvite", inviteRepository.deleteInvite(inviteId));
            log.info({ orgId: id, inviteId, email: invite.email }, "Invite cancelled");

            res.json({ message: "Invite cancelled" });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get invite details by token (public, for invite acceptance page)
     * @route GET /api/invites/:token
     */
    async getInviteByToken(req: Request, res: Response, next: NextFunction) {
        try {
            const token = req.params["token"]!;

            const time = createQueryTimer(log);
            const invite = await time("getInviteByToken", inviteRepository.getInviteByToken(token));
            if (!invite) {
                throw new AppError(404, "Invite not found or expired");
            }

            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(invite.orgId));
            if (!org) {
                throw new AppError(404, "Organization not found");
            }

            res.json({
                invite: {
                    email: invite.email,
                    role: invite.role,
                    expiresAt: invite.expiresAt,
                    organization: {
                        id: org.id,
                        name: org.name,
                    },
                },
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Accept an invite
     * @route POST /api/invites/:token/accept
     */
    async acceptInvite(req: Request, res: Response, next: NextFunction) {
        try {
            const token = req.params["token"]!;
            if (!req.auth?.userId) {
                throw new AppError(401, "Authentication required");
            }

            const time = createQueryTimer(log, { userId: req.auth.userId });
            const invite = await time("getInviteByToken", inviteRepository.getInviteByToken(token));
            if (!invite) {
                throw new AppError(404, "Invite not found or expired");
            }

            // The token is the capability, not the email. `invite.email` is
            // where the link was sent; the account that presents the link is
            // the one that joins, whatever its OAuth email — a GitHub account's
            // primary address is often not the work address an admin invites.
            // The token is 256 bits, single-use and expires in 7 days, which is
            // the same trust model as a GitHub or Slack invite link. Both
            // addresses are logged below so a mismatch is auditable.

            const isMember = await time("isMember", organizationRepository.isMember(invite.orgId, req.auth.userId));
            if (isMember) {
                // Delete the invite since they're already a member
                await time("deleteInvite", inviteRepository.deleteInvite(invite.id));
                throw new AppError(400, "You are already a member of this organization");
            }

            const org = await time("getOrganizationById", organizationRepository.getOrganizationById(invite.orgId));
            if (!org) {
                throw new AppError(404, "Organization not found");
            }

            // A user who signed up through the invite link has never been
            // through /users/setup (the client skips it on the invite page so
            // no personal org is created for them), so the users row may not
            // exist yet. org_members and terms acceptances both FK to it.
            const user = await time("ensureUserExists", userRepository.ensureUserExists({
                id: req.auth.userId,
                email: req.auth.user.email,
                name: req.auth.user.name,
            }));

            // Add the member and consume the invite atomically. The org row
            // lock serializes concurrent acceptances so they can't race past
            // the member limit, which is re-checked here: the plan may have
            // changed (or seats filled up) since the invite was created.
            const limits = getPlanLimits(org.plan);
            const userId = req.auth.userId;
            await time("acceptInviteTx", db.transaction(async (tx) => {
                await organizationRepository.lockOrganization(invite.orgId, tx);
                const memberCount = await organizationRepository.countMembers(invite.orgId, tx);
                if (memberCount >= limits.members) {
                    throw new AppError(403, `This organization has reached its member limit (${limits.members}). Ask an admin to upgrade the plan.`, true, "PLAN_LIMIT_EXCEEDED");
                }
                await organizationRepository.addOrgMember(invite.orgId, userId, invite.role as OrgRole, tx);
                await inviteRepository.deleteInvite(invite.id, tx);
                // The cloud records the terms acceptance the invite page
                // states next to its button — inside the transaction, so it
                // is rolled back with the membership on failure.
                await cloudHooks.onInviteAccepted({ userId, orgId: invite.orgId, role: invite.role as OrgRole, tx });
            }));

            log.info({
                orgId: invite.orgId,
                userId: req.auth.userId,
                role: invite.role,
                invitedEmail: invite.email,
                acceptedByEmail: req.auth.user.email,
            }, "Invite accepted");

            // The cloud's welcome email, for a user who signed up through the link.
            await time("cloudAfterInviteAccepted", cloudHooks.afterInviteAccepted({
                user: { id: user.id, email: user.email, name: user.name, isNew: user.isNew },
                org: { id: org.id, name: org.name },
                role: invite.role as OrgRole,
            }));

            res.json({
                message: "Invite accepted",
                organization: {
                    id: org.id,
                    name: org.name,
                    slug: org.slug,
                },
            });
        } catch (error) {
            next(error);
        }
    },

    /**
     * Get organization usage statistics for billing
     * @route GET /api/organizations/:id/usage
     */
    async getUsage(req: Request, res: Response, next: NextFunction) {
        try {
            const id = req.params["id"]!;

            const role = await getCurrentUserRole(req, id);
            if (!role) {
                throw new AppError(403, "Not a member of this organization");
            }

            const time = createQueryTimer(log, { orgId: id });

            const [memberCount, clusterCount] = await Promise.all([
                time("countMembers", organizationRepository.countMembers(id)),
                time("countClusters", clusterRepository.countByOrg(id)),
            ]);

            /* SBOMs stored, and unique images scanned this month.
             *
             * Both are now literally one number counted two ways over the same
             * rows, because one SBOM *is* one image. Before the cutover
             * "sbomsStored" fanned out per project, so an org running one base
             * image across twenty workloads was billed as twenty unique images
             * — the plan limit is called `uniqueImagesPerMonth` and finally
             * means it. */
            const [sbomCount, uniqueImagesThisMonth] = await Promise.all([
                time("countSboms", sbomRepository.countByOrg(id)),
                time("countSbomsThisMonth", sbomRepository.countThisMonthByOrg(id)),
            ]);

            res.json({
                usage: {
                    clusters: clusterCount,
                    uniqueImagesThisMonth,
                    members: memberCount,
                    sbomsStored: sbomCount,
                },
            });
        } catch (error) {
            next(error);
        }
    },
};
