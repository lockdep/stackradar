import { pgTable, uuid, varchar, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * Delivery status of a digest send, as Resend reports it. `sent` is written
 * from the API response; the rest arrive through the `/v1/webhooks/resend`
 * events, exactly as `org_invites.email_status` does.
 */
export const DIGEST_SEND_STATUSES = ["sent", "delivered", "delayed", "bounced", "complained", "failed"] as const;
export type DigestSendStatus = (typeof DIGEST_SEND_STATUSES)[number];

/** The webhook-reported subset — everything but `sent`, which the API response writes. */
export type DigestDeliveryStatus = Exclude<DigestSendStatus, "sent">;

/**
 * One row per weekly digest email handed to Resend — append-only evidence
 * of what was sent to whom, and the row the delivery webhook updates by
 * message id. Nothing reads it to decide whether to send: the idempotency
 * key on the send (`digest/<org>/<user>/<ISO week>`) is what stops a double
 * send, so a failed run can simply be re-run.
 */
export const digestSends = pgTable("digest_sends", {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** The address at send time — a user can change theirs afterwards. */
    email: varchar("email", { length: 255 }).notNull(),
    /** `YYYY-Www`, the ISO week the digest covers; part of the idempotency key. */
    week: varchar("week", { length: 10 }).notNull(),
    resendMessageId: varchar("resend_message_id", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().$type<DigestSendStatus>(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    index("digest_sends_org_id_idx").on(table.orgId),
    index("digest_sends_user_id_idx").on(table.userId),
    /** The webhook's lookup. */
    index("digest_sends_resend_message_id_idx").on(table.resendMessageId),
]);

export type DigestSend = typeof digestSends.$inferSelect;
export type NewDigestSend = typeof digestSends.$inferInsert;
