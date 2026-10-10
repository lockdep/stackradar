// SPDX-License-Identifier: LicenseRef-StackRadar-Cloud
import { count, desc, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
    feedback,
    users,
    organizations,
    type Feedback,
    type NewFeedback,
} from "../../db/schema/index.js";

/** One admin-list row: the message plus who wrote it, joined on for display. */
export interface AdminFeedbackEntry {
    id: string;
    message: string;
    page: string | null;
    createdAt: Date;
    userId: string;
    userName: string | null;
    userEmail: string;
    orgId: string | null;
    orgName: string | null;
}

export const feedbackRepository = {
    async create(data: NewFeedback): Promise<Feedback> {
        const [row] = await db.insert(feedback).values(data).returning();
        return row!;
    },

    /**
     * Cross-tenant list for the admin dashboard, newest first. The author is
     * an inner join — feedback cascades away with its user, so a row always
     * has one — while the org is a left join (SET NULL on org deletion).
     */
    async listAll(limit: number, offset: number): Promise<AdminFeedbackEntry[]> {
        return db
            .select({
                id: feedback.id,
                message: feedback.message,
                page: feedback.page,
                createdAt: feedback.createdAt,
                userId: feedback.userId,
                userName: users.name,
                userEmail: users.email,
                orgId: feedback.orgId,
                orgName: organizations.name,
            })
            .from(feedback)
            .innerJoin(users, eq(feedback.userId, users.id))
            .leftJoin(organizations, eq(feedback.orgId, organizations.id))
            .orderBy(desc(feedback.createdAt))
            .limit(limit)
            .offset(offset);
    },

    async countAll(): Promise<number> {
        const [row] = await db.select({ value: count() }).from(feedback);
        return row?.value ?? 0;
    },
};
