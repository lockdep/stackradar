import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Delivery state of the invite email. `not_configured` (no RESEND_API_KEY)
 * and `failed` (provider rejected the send) both leave the invite valid —
 * the admin can still share inviteUrl by hand. The post-`sent` states are
 * written by the Resend webhook.
 */
export const INVITE_EMAIL_STATUSES = [
    "not_configured",
    "failed",
    "sent",
    "delivered",
    "delayed",
    "bounced",
    "complained",
] as const;
export type InviteEmailStatus = (typeof INVITE_EMAIL_STATUSES)[number];
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import type { OrgRole } from "./org-members.js";

/**
 * Organization invites table
 * Tracks pending invitations to join an organization
 */
export const orgInvites = pgTable(
    "org_invites",
    {
        id: uuid("id").primaryKey().defaultRandom(),

        // Organization being invited to
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),

        // Invited user's email
        email: varchar("email", { length: 255 }).notNull(),

        // Role to assign when invite is accepted: "admin" or "member"
        role: varchar("role", { length: 50 }).notNull().default("member").$type<Exclude<OrgRole, "owner">>(),

        // User who sent the invite. Nullable + SET NULL by decision: an invite
        // should survive its inviter's account deletion — the inviter is display
        // attribution, not part of the invite's validity.
        invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),

        // Unique token for invite acceptance
        token: varchar("token", { length: 64 }).notNull().unique(),

        // Expiration timestamp
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

        // Invite email delivery tracking. Null until a send was attempted.
        emailStatus: varchar("email_status", { length: 20 }).$type<InviteEmailStatus>(),
        // Provider (Resend) message id — the key the webhook events carry.
        emailMessageId: varchar("email_message_id", { length: 64 }),
        emailStatusAt: timestamp("email_status_at", { withTimezone: true }),

        // Timestamps
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // getOrgInvites / findExistingInvite filter on orgId + expiresAt
        index("org_invites_org_id_expires_at_idx").on(table.orgId, table.expiresAt),
        // getOrgInvites JOINs on invitedBy
        index("org_invites_invited_by_idx").on(table.invitedBy),
        // findExistingInvite / deleteInvitesByEmail filter on (org_id, email).
        // Email is already lowercased at write time, so a plain composite is
        // sufficient.
        index("org_invites_org_email_idx").on(table.orgId, table.email),
        // Resend webhook looks invites up by provider message id
        index("org_invites_email_message_id_idx").on(table.emailMessageId),
    ],
);

export type OrgInvite = typeof orgInvites.$inferSelect;
export type NewOrgInvite = typeof orgInvites.$inferInsert;
