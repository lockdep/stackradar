import { eq, and, isNull, sql } from "drizzle-orm";
import { db, type Transaction } from "../db/index.js";
import {
    apiKeys,
    organizations,
    orgInvites,
    orgMembers,
    users,
    type NewOrganization,
    type Organization,
    type OrgRole,
    type PlanType,
} from "../db/schema/index.js";
import { generateUniqueSlug } from "../lib/slug.js";

interface UpdatePlanOptions {
    stripeCustomerId?: string;
    stripeSubscriptionId?: string | null;
    stripeSubscriptionStatus?: string | null;
    stripeCurrentPeriodEnd?: Date | null;
    stripeCancelAt?: Date | null;
}

export const organizationRepository = {
    /**
     * Check if a user is an admin or owner
     */
    isAdminOrOwner(role: OrgRole): boolean {
        return role === "admin" || role === "owner";
    },

    /**
     * Check if a user is the owner
     */
    isOwner(role: OrgRole): boolean {
        return role === "owner";
    },

    /**
     * Create a new organization
     */
    async createOrganization(data: Pick<NewOrganization, "name"> & { ownerId: string }): Promise<Organization> {
        const slug = generateUniqueSlug(data.name);

        // Create organization
        const [org] = await db
            .insert(organizations)
            .values({
                name: data.name,
                slug,
                plan: "free",
            })
            .returning();

        if (!org) {
            throw new Error("Failed to create organization");
        }

        // Add owner as member
        await db.insert(orgMembers).values({
            userId: data.ownerId,
            orgId: org.id,
            role: "owner",
        });

        return org;
    },

    /**
     * Get organization by Stripe customer ID (excludes soft-deleted)
     */
    async getOrganizationByStripeCustomerId(customerId: string): Promise<Organization | null> {
        const [org] = await db
            .select()
            .from(organizations)
            .where(and(eq(organizations.stripeCustomerId, customerId), isNull(organizations.deletedAt)))
            .limit(1);

        return org || null;
    },

    /**
     * Get organization by ID (excludes soft-deleted)
     */
    async getOrganizationById(id: string): Promise<Organization | null> {
        const [org] = await db
            .select()
            .from(organizations)
            .where(and(eq(organizations.id, id), isNull(organizations.deletedAt)))
            .limit(1);

        return org || null;
    },

    /**
     * Get all organizations a user belongs to (excludes soft-deleted)
     */
    async getUserOrganizations(userId: string): Promise<Array<Organization & { role: OrgRole }>> {
        const result = await db
            .select({
                org: organizations,
                role: orgMembers.role,
            })
            .from(orgMembers)
            .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
            .where(and(eq(orgMembers.userId, userId), isNull(organizations.deletedAt)));

        return result.map(({ org, role }) => ({ ...org, role: role as OrgRole }));
    },

    /**
     * Whether the user belongs to any live organization on the free plan.
     *
     * Plan limits are per org, so without this check a user could take a
     * second free cluster by creating a second free org. Membership, not
     * ownership, is what counts: a free org holds exactly one member (the
     * owner), and the rule is "one free org per person", not "per owner".
     */
    async hasFreeOrganization(userId: string): Promise<boolean> {
        const [row] = await db
            .select({ id: organizations.id })
            .from(orgMembers)
            .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
            .where(and(eq(orgMembers.userId, userId), eq(organizations.plan, "free"), isNull(organizations.deletedAt)))
            .limit(1);
        return row !== undefined;
    },

    /**
     * Add a member to an organization.
     *
     * A **system** org (the StackRadar platform org that owns the candidate
     * chart scans) refuses membership outright: nobody acts inside it, so nobody may
     * join it — enforced here, the one member-write path, rather than by
     * convention.
     *
     * A **demo** org (`organizations.demo`, the public read-only demo) refuses too: its only member is
     * the demo visitor, and that row is inserted directly by the seed script
     * (`scripts/seed-demo.ts`), never through here. An invite to the demo org
     * cannot be sent (the demo visitor is a `member`, and read-only), but an
     * admin of some other org must not be addable either — this is where
     * that is closed.
     */
    async addOrgMember(orgId: string, userId: string, role: OrgRole = "member", tx?: Transaction): Promise<void> {
        const [org] = await (tx ?? db)
            .select({ system: organizations.system, demo: organizations.demo })
            .from(organizations)
            .where(eq(organizations.id, orgId));
        if (org?.system) {
            throw new Error("Members cannot be added to a system organization");
        }
        if (org?.demo) {
            throw new Error("Members cannot be added to a demo organization");
        }

        await (tx ?? db).insert(orgMembers).values({
            userId,
            orgId,
            role,
        });
    },

    /**
     * Whether the organization has an owner. The community edition's
     * first-login rule (`user.controller.setup`): the first account to sign
     * in owns the default organization, every later one joins as a member.
     * Read under `lockOrganization` so two first logins cannot both see
     * "no owner".
     */
    async hasOwner(orgId: string, tx?: Transaction): Promise<boolean> {
        const [row] = await (tx ?? db)
            .select({ userId: orgMembers.userId })
            .from(orgMembers)
            .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, "owner")))
            .limit(1);
        return row !== undefined;
    },

    /**
     * Count current members of an organization
     */
    async countMembers(orgId: string, tx?: Transaction): Promise<number> {
        const [result] = await (tx ?? db)
            .select({ count: sql<number>`count(*)::int` })
            .from(orgMembers)
            .where(eq(orgMembers.orgId, orgId));

        return result?.count ?? 0;
    },

    /**
     * Lock the organization row for the duration of the transaction.
     * Serializes concurrent membership changes (e.g. two invite acceptances
     * racing past the member limit) via SELECT FOR UPDATE.
     */
    async lockOrganization(orgId: string, tx: Transaction): Promise<void> {
        await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, orgId))
            .for("update")
            .limit(1);
    },

    /**
     * Remove a member from an organization
     */
    async removeOrgMember(orgId: string, userId: string): Promise<void> {
        await db.delete(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    },

    /**
     * Get organization members
     */
    async getOrgMembers(orgId: string) {
        return db
            .select({
                user: users,
                role: orgMembers.role,
                joinedAt: orgMembers.joinedAt,
            })
            .from(orgMembers)
            .innerJoin(users, eq(orgMembers.userId, users.id))
            .where(eq(orgMembers.orgId, orgId));
    },

    /**
     * Update organization plan
     */
    async updateOrganizationPlan(orgId: string, plan: PlanType, options: UpdatePlanOptions = {}): Promise<void> {
        await db
            .update(organizations)
            .set({
                plan,
                ...options,
                updatedAt: new Date(),
            })
            .where(eq(organizations.id, orgId));
    },

    /**
     * Get a user's role in an organization
     */
    async getUserRole(orgId: string, userId: string): Promise<OrgRole | null> {
        const [member] = await db
            .select({ role: orgMembers.role })
            .from(orgMembers)
            .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
            .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), isNull(organizations.deletedAt)))
            .limit(1);

        return member ? (member.role as OrgRole) : null;
    },

    /**
     * Resolve a user's membership in an organization together with the org
     * row itself, in one query. This is the server-side re-verification that
     * `requireOrg` runs on every internal request (security review S3): the
     * BFF's `X-Org-Id` header is a claim, not proof, and the org's `plan`
     * must come from the database rather than a header (S16). Deleted orgs
     * resolve to null — membership in a deleted org is not membership.
     */
    async getMembership(orgId: string, userId: string): Promise<{ role: OrgRole; org: Organization } | null> {
        const [row] = await db
            .select({ role: orgMembers.role, org: organizations })
            .from(orgMembers)
            .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
            .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId), isNull(organizations.deletedAt)))
            .limit(1);

        return row ? { role: row.role as OrgRole, org: row.org } : null;
    },

    /**
     * Update a member's role in an organization
     */
    async updateMemberRole(orgId: string, userId: string, newRole: OrgRole): Promise<void> {
        await db
            .update(orgMembers)
            .set({ role: newRole })
            .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    },

    /**
     * Update organization settings
     */
    async updateOrganization(
        orgId: string,
        data: {
            name?: string | undefined;
            color?: string | null | undefined;
            weeklyDigestEnabled?: boolean | undefined;
            defaultFindingTier?: "application" | "all" | undefined;
        },
    ): Promise<Organization | null> {
        const updateData: Partial<Organization> = { updatedAt: new Date() };

        if (data.name !== undefined) {
            updateData.name = data.name;
        }

        if (data.color !== undefined) {
            updateData.color = data.color as Organization["color"];
        }

        if (data.weeklyDigestEnabled !== undefined) {
            updateData.weeklyDigestEnabled = data.weeklyDigestEnabled;
        }

        if (data.defaultFindingTier !== undefined) {
            updateData.defaultFindingTier = data.defaultFindingTier;
        }

        const [updated] = await db
            .update(organizations)
            .set(updateData)
            .where(and(eq(organizations.id, orgId), isNull(organizations.deletedAt)))
            .returning();

        return updated || null;
    },

    /**
     * Soft delete an organization.
     *
     * Deleting the org must also cut off everything that could keep acting
     * on its behalf (security review S5): scanner API keys are deactivated
     * so ingest stops immediately, and pending invites are removed so the
     * invite links stop resolving. All in one transaction — a half-deleted
     * org whose keys still work is the failure mode this exists to prevent.
     */
    async deleteOrganization(orgId: string): Promise<void> {
        const now = new Date();
        await db.transaction(async (tx) => {
            await tx.update(organizations).set({ deletedAt: now, updatedAt: now }).where(eq(organizations.id, orgId));
            await tx.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.orgId, orgId));
            await tx.delete(orgInvites).where(eq(orgInvites.orgId, orgId));
        });
    },

    /**
     * Check if a user is a member of an organization
     */
    async isMember(orgId: string, userId: string): Promise<boolean> {
        const role = await organizationRepository.getUserRole(orgId, userId);
        return role !== null;
    },

    /**
     * Check if user is already a member by email
     */
    async isMemberByEmail(orgId: string, email: string): Promise<boolean> {
        const [member] = await db
            .select({ id: users.id })
            .from(orgMembers)
            .innerJoin(users, eq(orgMembers.userId, users.id))
            .where(and(eq(orgMembers.orgId, orgId), sql`LOWER(${users.email}) = LOWER(${email})`))
            .limit(1);

        return !!member;
    },
};
