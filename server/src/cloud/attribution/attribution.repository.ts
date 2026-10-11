// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { and, eq, isNull, isNotNull, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { signupAttributions, type SignupAttribution } from "../../db/schema/index.js";

export interface SignupAttributionInput {
    clickId?: string | undefined;
    utmSource?: string | undefined;
    utmMedium?: string | undefined;
    utmCampaign?: string | undefined;
    utmContent?: string | undefined;
    utmTerm?: string | undefined;
    timezone?: string | undefined;
    locale?: string | undefined;
}

export const attributionRepository = {
    /**
     * Record a self-sign-up and where it came from (every field of `input`
     * may be absent: an organic sign-up still gets its row). One row per
     * user, first write wins: setup is idempotent on the client side (a
     * reload re-posts it), and the attribution that created the account is
     * the one to keep.
     */
    async create(userId: string, orgId: string, input: SignupAttributionInput): Promise<SignupAttribution | undefined> {
        const [row] = await db
            .insert(signupAttributions)
            .values({
                userId,
                orgId,
                clickId: input.clickId ?? null,
                utmSource: input.utmSource ?? null,
                utmMedium: input.utmMedium ?? null,
                utmCampaign: input.utmCampaign ?? null,
                utmContent: input.utmContent ?? null,
                utmTerm: input.utmTerm ?? null,
                timezone: input.timezone ?? null,
                locale: input.locale ?? null,
            })
            .onConflictDoNothing()
            .returning();
        return row;
    },

    /**
     * Rows in this org that still owe a cluster-connected event to someone:
     * the analytics event and the founder alert (every row, until stamped)
     * or the ad-network conversion (rows with a click id, until stamped).
     * Normally zero rows (an org whose founder was invited, or one that has
     * already reported) or one (the founder, on the org's first report).
     */
    async findPendingClusterEvents(orgId: string): Promise<SignupAttribution[]> {
        return db
            .select()
            .from(signupAttributions)
            .where(
                and(
                    eq(signupAttributions.orgId, orgId),
                    or(
                        isNull(signupAttributions.analyticsClusterSentAt),
                        isNull(signupAttributions.founderClusterAlertSentAt),
                        and(isNotNull(signupAttributions.clickId), isNull(signupAttributions.clusterEventSentAt)),
                    ),
                ),
            );
    },

    async markSignupEventSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ signupEventSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },

    async markClusterEventSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ clusterEventSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },

    async markAnalyticsSignupSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ analyticsSignupSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },

    async markAnalyticsClusterSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ analyticsClusterSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },

    async markFounderSignupAlertSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ founderSignupAlertSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },

    async markFounderClusterAlertSent(userId: string): Promise<void> {
        await db
            .update(signupAttributions)
            .set({ founderClusterAlertSentAt: new Date() })
            .where(eq(signupAttributions.userId, userId));
    },
};
