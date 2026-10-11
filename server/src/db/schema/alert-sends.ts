import { pgTable, uuid, varchar, text, jsonb, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizations } from "./organizations.js";
import { users } from "./users.js";
import type { DigestSendStatus } from "./digest-sends.js";

/** The two channels an alert goes out on. */
export const ALERT_CHANNELS = ["email", "slack"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/**
 * Delivery status of one alert message. Email uses the digest's vocabulary
 * (`sent` from the API response, the rest from the Resend webhook); a Slack
 * webhook only ever answers `sent` or `failed`.
 */
export type AlertSendStatus = DigestSendStatus;

/**
 * One row per alert message handed to a channel — the append-only evidence
 * that a critical or KEV finding was told to someone, and when. Like
 * `digest_sends`, nothing reads it to decide whether to send: the org's
 * `alerts_cursor_at` is the watermark and the Resend idempotency key is the
 * double-send guard. What it is read for is the settings page's "last
 * delivered" line and, for Slack, the reason a webhook is failing.
 *
 * `event_ids` is the batch the message covered, so a delivery can be traced
 * back to the events (and from them to the scans) that caused it.
 */
export const alertSends = pgTable(
    "alert_sends",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        orgId: uuid("org_id")
            .notNull()
            .references(() => organizations.id, { onDelete: "cascade" }),
        channel: varchar("channel", { length: 10 }).notNull().$type<AlertChannel>(),
        /** The recipient user for email; null for the org's Slack webhook. */
        userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
        /** The address at send time, or the webhook's host for Slack — never the webhook URL itself. */
        recipient: varchar("recipient", { length: 255 }).notNull(),
        /** What the message led with — the subject line, or the Slack headline. */
        subject: text("subject").notNull(),
        /** The `activity_events` ids the message covered. Jsonb array of uuids. */
        eventIds: jsonb("event_ids").notNull().$type<string[]>().default([]),
        /** Distinct advisories named in the message. */
        advisoryCount: integer("advisory_count").notNull().default(0),
        /** `test` for the settings page's "send a test", `alert` otherwise. */
        kind: varchar("kind", { length: 10 }).notNull().default("alert").$type<"alert" | "test">(),
        resendMessageId: varchar("resend_message_id", { length: 64 }),
        status: varchar("status", { length: 20 }).notNull().$type<AlertSendStatus>(),
        /** The channel's own words when it refused, truncated. */
        error: text("error"),
        sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        /** The settings page reads an org's recent sends newest first. */
        index("alert_sends_org_sent_idx").on(table.orgId, table.sentAt),
        index("alert_sends_user_id_idx").on(table.userId),
        /** The webhook's lookup. */
        index("alert_sends_resend_message_id_idx").on(table.resendMessageId),
    ],
);

export type AlertSend = typeof alertSends.$inferSelect;
export type NewAlertSend = typeof alertSends.$inferInsert;
