import { eq, and, gt, lt, sql } from "drizzle-orm";
import { db, type Transaction } from "../db/index.js";
import { orgInvites, users, type InviteEmailStatus, type NewOrgInvite, type OrgInvite } from "../db/schema/index.js";
import crypto from "crypto";

/**
 * Generate a secure random token for invites
 */
function generateToken(): string {
    return crypto.randomBytes(32).toString("hex");
}

export const inviteRepository = {
    /**
     * Create a new organization invite
     */
    async createInvite(data: Pick<NewOrgInvite, "orgId" | "email" | "role" | "invitedBy">): Promise<OrgInvite> {
        const token = generateToken();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        const [invite] = await db
            .insert(orgInvites)
            .values({
                orgId: data.orgId,
                email: data.email.toLowerCase(),
                role: data.role || "member",
                invitedBy: data.invitedBy,
                token,
                expiresAt,
            })
            .returning();

        if (!invite) {
            throw new Error("Failed to create invite");
        }

        return invite;
    },

    /**
     * Get invite by ID
     */
    async getInviteById(id: string): Promise<OrgInvite | null> {
        const [invite] = await db.select().from(orgInvites).where(eq(orgInvites.id, id)).limit(1);

        return invite || null;
    },

    /**
     * Get invite by token (only if not expired)
     */
    async getInviteByToken(token: string): Promise<OrgInvite | null> {
        const [invite] = await db
            .select()
            .from(orgInvites)
            .where(and(eq(orgInvites.token, token), gt(orgInvites.expiresAt, new Date())))
            .limit(1);

        return invite || null;
    },

    /**
     * Get all pending invites for an organization.
     *
     * LEFT JOIN, not INNER: `invited_by` is nullable (SET NULL on user
     * deletion), and an invite must not vanish from the list because its
     * inviter deleted their account. `invitedByUser` is null in that case.
     */
    async getOrgInvites(orgId: string) {
        return db
            .select({
                invite: orgInvites,
                invitedByUser: {
                    id: users.id,
                    name: users.name,
                    email: users.email,
                },
            })
            .from(orgInvites)
            .leftJoin(users, eq(orgInvites.invitedBy, users.id))
            .where(and(eq(orgInvites.orgId, orgId), gt(orgInvites.expiresAt, new Date())));
    },

    /**
     * Check if an invite already exists for an email in an organization
     */
    async findExistingInvite(orgId: string, email: string): Promise<OrgInvite | null> {
        const [invite] = await db
            .select()
            .from(orgInvites)
            .where(
                and(
                    eq(orgInvites.orgId, orgId),
                    eq(orgInvites.email, email.toLowerCase()),
                    gt(orgInvites.expiresAt, new Date()),
                ),
            )
            .limit(1);

        return invite || null;
    },

    /**
     * Count pending (non-expired) invites for an organization
     */
    async countPendingInvites(orgId: string, tx?: Transaction): Promise<number> {
        const [result] = await (tx ?? db)
            .select({ count: sql<number>`count(*)::int` })
            .from(orgInvites)
            .where(and(eq(orgInvites.orgId, orgId), gt(orgInvites.expiresAt, new Date())));

        return result?.count ?? 0;
    },

    /**
     * Delete an invite by ID
     */
    async deleteInvite(id: string, tx?: Transaction): Promise<void> {
        await (tx ?? db).delete(orgInvites).where(eq(orgInvites.id, id));
    },

    /**
     * Delete all invites for an email in an organization
     */
    async deleteInvitesByEmail(orgId: string, email: string): Promise<void> {
        await db.delete(orgInvites).where(and(eq(orgInvites.orgId, orgId), eq(orgInvites.email, email.toLowerCase())));
    },

    /**
     * Clean up expired invites
     */
    // Note: no sweep calls this yet — the Members/Invites surface is still being
    // wired up, and the expiry cron that should own this call does not exist yet.
    async deleteExpiredInvites(): Promise<number> {
        const result = await db.delete(orgInvites).where(lt(orgInvites.expiresAt, new Date())).returning();

        return result.length;
    },

    /**
     * Record the outcome of sending the invite email.
     */
    async setEmailStatus(id: string, status: InviteEmailStatus, messageId: string | null = null): Promise<void> {
        await db
            .update(orgInvites)
            .set({ emailStatus: status, emailMessageId: messageId, emailStatusAt: new Date() })
            .where(eq(orgInvites.id, id));
    },

    /**
     * Apply a delivery event from the email provider's webhook, keyed by the
     * provider message id. Returns false when no invite carries that id
     * (non-invite mail, or the invite was accepted/cancelled and deleted).
     */
    async applyEmailEvent(messageId: string, status: InviteEmailStatus, at: Date): Promise<boolean> {
        const rows = await db
            .update(orgInvites)
            .set({ emailStatus: status, emailStatusAt: at })
            .where(eq(orgInvites.emailMessageId, messageId))
            .returning({ id: orgInvites.id });
        return rows.length > 0;
    },
};
