// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { and, eq, exists, isNull, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { isTenantOrg } from "../../db/tenant-orgs.js";
import type { DigestSendStatus, NewDigestSend } from "../../db/schema/digest-sends.js";
import type { InviteEmailStatus } from "../../db/schema/org-invites.js";

/**
 * Who the weekly digest goes to, and the log of what was sent.
 */
export const digestRepository = {
    /**
     * Orgs due a digest: tenants (not the platform org, not the demo org),
     * not deleted, digest enabled, and with at least one scanned image —
     * an org with nothing scanned has nothing to say.
     */
    async findDigestOrgs(): Promise<{ id: string; name: string }[]> {
        const o = schema.organizations;
        return db
            .select({ id: o.id, name: o.name })
            .from(o)
            .where(
                and(
                    isTenantOrg(),
                    isNull(o.deletedAt),
                    eq(o.weeklyDigestEnabled, true),
                    exists(
                        db
                            .select({ one: sql`1` })
                            .from(schema.sboms)
                            .innerJoin(schema.images, eq(schema.images.id, schema.sboms.imageId))
                            .where(eq(schema.images.orgId, o.id))
                    )
                )
            )
            .orderBy(o.createdAt);
    },

    /** Owners and admins of the org, minus the shared demo visitor. */
    async findRecipients(orgId: string): Promise<{ id: string; email: string; name: string | null }[]> {
        const rows = await db
            .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.orgMembers.role })
            .from(schema.orgMembers)
            .innerJoin(schema.users, eq(schema.users.id, schema.orgMembers.userId))
            .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.users.demo, false)))
            .orderBy(schema.users.email);
        return rows
            .filter((r) => r.role === "owner" || r.role === "admin")
            .map(({ id, email, name }) => ({ id, email, name }));
    },

    async recordSend(data: NewDigestSend): Promise<void> {
        await db.insert(schema.digestSends).values(data);
    },

    /**
     * Apply a delivery event from the provider's webhook, keyed by message
     * id. False when no digest send carries that id.
     */
    async applyEmailEvent(messageId: string, status: InviteEmailStatus, at: Date): Promise<boolean> {
        /* The webhook maps Resend events with the invite vocabulary; every
           value it can produce is a digest status too, except the invite-only
           `not_configured`, which no webhook event maps to. */
        if (status === "not_configured") return false;
        const rows = await db
            .update(schema.digestSends)
            .set({ status: status as DigestSendStatus, updatedAt: at })
            .where(eq(schema.digestSends.resendMessageId, messageId))
            .returning({ id: schema.digestSends.id });
        return rows.length > 0;
    },

    /** Switch the org's digest off — the unsubscribe link and the settings toggle. */
    async setEnabled(orgId: string, enabled: boolean): Promise<boolean> {
        const rows = await db
            .update(schema.organizations)
            .set({ weeklyDigestEnabled: enabled, updatedAt: new Date() })
            .where(and(eq(schema.organizations.id, orgId), isNull(schema.organizations.deletedAt)))
            .returning({ id: schema.organizations.id });
        return rows.length > 0;
    },
};
