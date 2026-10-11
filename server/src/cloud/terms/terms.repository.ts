// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { eq, desc } from "drizzle-orm";
import { db, type Transaction } from "../../db/index.js";
import {
    termsAcceptances,
    orgTermsAcceptances,
    orgMembers,
    type TermsAcceptance,
    type OrgRole,
} from "../../db/schema/index.js";

export const termsRepository = {
    /**
     * Record that a user accepted a version of the terms. Idempotent: the
     * table keeps one row per (user, version), and the first acceptance wins
     * so the recorded timestamp is never rewritten.
     */
    async recordAcceptance(userId: string, termsVersion: string, tx?: Transaction): Promise<void> {
        await (tx ?? db).insert(termsAcceptances).values({ userId, termsVersion }).onConflictDoNothing();
    },

    /**
     * The user's most recent acceptance, or undefined if they have never
     * accepted any version.
     */
    async getLatestAcceptance(userId: string): Promise<TermsAcceptance | undefined> {
        const [row] = await db
            .select()
            .from(termsAcceptances)
            .where(eq(termsAcceptances.userId, userId))
            .orderBy(desc(termsAcceptances.acceptedAt))
            .limit(1);
        return row;
    },

    /**
     * Record that a version was accepted on behalf of one organisation, with
     * the acceptor's role frozen at this moment. Idempotent per (org,
     * version): the first acceptance binds the org, later ones are no-ops.
     */
    async recordOrgAcceptance(
        orgId: string,
        userId: string,
        role: OrgRole,
        termsVersion: string,
        tx?: Transaction,
    ): Promise<void> {
        await (tx ?? db)
            .insert(orgTermsAcceptances)
            .values({ orgId, acceptedByUserId: userId, acceptedByRole: role, termsVersion })
            .onConflictDoNothing();
    },

    /**
     * Record a version as accepted on behalf of every organisation the user
     * is currently a member of, each with the user's role in that org. Used
     * by the explicit accept endpoint: any member's acceptance binds their
     * orgs for now (see the schema comment for the planned admin-only
     * tightening — it happens here and at the other call sites, not in the
     * table).
     */
    async recordAcceptanceForMemberOrgs(userId: string, termsVersion: string, tx?: Transaction): Promise<void> {
        const memberships = await (tx ?? db)
            .select({ orgId: orgMembers.orgId, role: orgMembers.role })
            .from(orgMembers)
            .where(eq(orgMembers.userId, userId));
        if (memberships.length === 0) return;

        await (tx ?? db)
            .insert(orgTermsAcceptances)
            .values(
                memberships.map((m) => ({
                    orgId: m.orgId,
                    acceptedByUserId: userId,
                    acceptedByRole: m.role,
                    termsVersion,
                })),
            )
            .onConflictDoNothing();
    },
};
