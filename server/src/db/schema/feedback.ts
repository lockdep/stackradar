import { pgTable, uuid, text, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { organizations } from "./organizations.js";

/**
 * In-app feedback, written by the signed-in user via the sidebar's
 * "Send feedback" dialog and read only on the admin dashboard's Feedback tab.
 * Free-form and append-only from the app's point of view: there is no status
 * or triage workflow — the admin list *is* the inbox.
 */
export const feedback = pgTable("feedback", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // The org that was active when the feedback was sent — context, not
    // tenancy. SET NULL so the message survives the org being deleted.
    orgId: uuid("org_id").references(() => organizations.id, { onDelete: "set null" }),
    message: text("message").notNull(),
    // The in-app path the dialog was opened from ("/clusters/…"), captured by
    // the client. Context for the reader; null when the client didn't send it.
    page: varchar("page", { length: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    // Cover the FKs' referential actions on user erasure and org deletion.
    index("feedback_user_id_idx").on(table.userId),
    index("feedback_org_id_idx").on(table.orgId),
]);

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
